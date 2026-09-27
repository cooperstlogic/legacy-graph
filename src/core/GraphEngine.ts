import Graph from 'graphology';
import * as path from 'path';
import watcher from '@parcel/watcher';
import type { AsyncSubscription } from '@parcel/watcher';
import fg from 'fast-glob';
import pLimit from 'p-limit';
import { Worker } from 'worker_threads';
import { BootLoader } from './BootLoader';
import { StoryLoader, Story } from './StoryLoader';
import { SearchService } from './SearchService';
import { GraphCache, GraphCacheFile } from './GraphCache';
import { HydrationWorkerResult, HydrationWorkerError, HydrationWorkerProgress } from './HydrationWorker';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import { realpathSync } from 'fs';
import { loadYaml, dumpYaml } from './yaml';
import { PersonSchema, SlimPerson, toSlimPerson, PersonEntry } from '../schemas/PersonSchema';
import { StorySchema } from '../schemas/StorySchema';
import { computeAllRelationships, invalidateComputed } from './GraphLogic';
import { generatePersonId } from '../utils/idGenerator';
import matter from 'gray-matter';
import { remark } from 'remark';
import { visit } from 'unist-util-visit';

export interface HydrationResult {
    fromCache: number;
    parsed: number;
    total: number;
}

export class GraphEngine extends EventEmitter {
    private graph: Graph;
    private rootDir: string;
    public searchService: SearchService;
    private _hydrationState: 'loading' | 'ready' = 'loading';
    private _cacheWrittenAt: string | null = null;
    private _hydrationStartTime: number = 0;

    constructor(rootDir: string) {
        super();
        this.rootDir = rootDir;
        this.graph = new Graph({ type: 'directed', multi: true });
        this.searchService = new SearchService();
        this.searchService.setPersistencePath(this.searchIndexPath);
    }

    /**
     * Returns the raw Graphology instance for querying.
     */
    public getGraph(): Graph {
        return this.graph;
    }

    /**
     * Current hydration state: 'loading' before/during hydration, 'ready' after.
     */
    public get hydrationState(): 'loading' | 'ready' {
        return this._hydrationState;
    }

    /**
     * ISO-8601 timestamp of when the binary cache was last written, or null if no cache exists.
     */
    public get cacheAge(): string | null {
        return this._cacheWrittenAt;
    }

    private fileMap: Map<string, string> = new Map(); // FilePath -> PersonID
    private reverseFileMap: Map<string, string> = new Map(); // PersonID -> FilePath
    private selfWriteMap: Map<string, number> = new Map(); // Canonical path -> expiry timestamp
    private canonicalDirCache: Map<string, string> = new Map(); // Directory as given -> realpath

    private watcherEventCount = 0;
    private watcherWindowStart = 0;
    private watcherSuspended = false;
    private watcherSuspendedUntil = 0; // grace period after suspension ends

    /**
     * Canonical form of a file path for self-write keys. The watcher reports real
     * paths, while writers join paths onto the configured data dir, which may be
     * relative or pass through a symlink (macOS /var → /private/var). The parent
     * directory is resolved rather than the file so deleted files still map.
     */
    private selfWriteKey(filePath: string): string {
        const dir = path.dirname(filePath);
        let canonicalDir = this.canonicalDirCache.get(dir);
        if (canonicalDir === undefined) {
            try {
                canonicalDir = realpathSync(dir);
                this.canonicalDirCache.set(dir, canonicalDir);
            } catch {
                // Directory doesn't exist (yet): don't cache the fallback
                canonicalDir = path.resolve(dir);
            }
        }
        return path.join(canonicalDir, path.basename(filePath));
    }

    /**
     * Register a file path as written by the application itself.
     * The watcher will skip hot-patching for this file on the next event.
     * Entries expire after ttlMs (default 10000ms) to prevent memory leaks.
     */
    public registerSelfWrite(absolutePath: string, ttlMs: number = 10000): void {
        this.selfWriteMap.set(this.selfWriteKey(absolutePath), Date.now() + ttlMs);
    }

    /**
     * Check if a file path is in the self-write set (not expired).
     */
    public hasSelfWrite(absolutePath: string): boolean {
        const key = this.selfWriteKey(absolutePath);
        const expiry = this.selfWriteMap.get(key);
        if (expiry === undefined) return false;
        if (Date.now() > expiry) {
            this.selfWriteMap.delete(key);
            return false;
        }
        return true;
    }

    /**
     * Consume (remove) a self-write entry if it exists and is not expired.
     * Returns true if the entry was consumed, false if not found or expired.
     */
    public consumeSelfWrite(absolutePath: string): boolean {
        const key = this.selfWriteKey(absolutePath);
        const expiry = this.selfWriteMap.get(key);
        if (expiry === undefined) return false;
        this.selfWriteMap.delete(key);
        return Date.now() <= expiry;
    }

    /**
     * Record the source YAML for a person the API just wrote. The watcher skips
     * self-writes, so without this a person created via the API has no file mapping
     * and loadHeavyFields() can't find its scrapbook_md or _gedcom.
     */
    public registerPersonFile(personId: string, filePath: string): void {
        const previous = this.reverseFileMap.get(personId);
        if (previous !== undefined && previous !== filePath) {
            this.fileMap.delete(previous);
        }
        this.fileMap.set(filePath, personId);
        this.reverseFileMap.set(personId, filePath);
    }

    /**
     * Reverse lookup: get the source YAML file path for a person ID.
     * Used by the API to lazy-load heavy fields (scrapbook_md, _gedcom) from disk.
     */
    public getFilePathForPerson(personId: string): string | undefined {
        return this.reverseFileMap.get(personId);
    }

    /**
     * Lazy-load heavy fields (scrapbook_md, _gedcom) from the source YAML on disk.
     * These fields are stripped from the in-memory graph to reduce V8 heap usage (Slim Node Strategy).
     * Returns null if the person ID is unknown or the file cannot be read.
     */
    public async loadHeavyFields(personId: string): Promise<{ scrapbook_md: string; _gedcom?: Record<string, any> } | null> {
        const filePath = this.reverseFileMap.get(personId);
        if (!filePath) return null;

        try {
            const content = await fs.readFile(filePath, 'utf8');
            const raw = loadYaml(content) as any;
            return {
                scrapbook_md: raw.scrapbook_md ?? '',
                _gedcom: raw._gedcom
            };
        } catch {
            return null;
        }
    }

    /**
     * Cache file path for the binary graph cache.
     */
    private get cachePath(): string {
        return path.join(this.rootDir, '_meta', '.graph-cache.json');
    }

    /**
     * File path for the persistent search index cache.
     */
    private get searchIndexPath(): string {
        return path.join(this.rootDir, '_meta', '.search-index.json');
    }

    /**
     * Loads all data from the file system and rebuilds the graph (inline, on the main thread).
     * Uses the Tiered Binary Cache when available for accelerated boot.
     * Retained for testing, simple usage, and as a fallback for worker failures.
     *
     * @param options.forceFullRebuild - Bypass cache and re-parse all YAML files (used by POST /system/rebuild)
     * @returns Hydration statistics (fromCache, parsed, total)
     */
    public async hydrate(options?: { forceFullRebuild?: boolean }): Promise<HydrationResult> {
        this._hydrationState = 'loading';
        this._hydrationStartTime = Date.now();
        this.watcherSuspended = true;
        console.log(`[GraphEngine] Hydrating graph (inline) from: ${this.rootDir}`);

        try {
            // 1. Load People — via cache (incremental) or full nuclear
            const cache = options?.forceFullRebuild
                ? null
                : await GraphCache.load(this.cachePath);

            let peopleWithMtime: PersonEntry[];
            let fromCache = 0;
            let parsed = 0;

            if (cache) {
                const result = await this.loadPeopleIncremental(cache);
                peopleWithMtime = result.results;
                fromCache = result.fromCache;
                parsed = result.parsed;
            } else {
                const result = await this.loadPeopleFull();
                peopleWithMtime = result.results;
                parsed = result.parsed;
            }

            // 2. Load Stories (Narrative Layer — always from disk)
            const storyLoader = new StoryLoader(path.join(this.rootDir, 'stories'));
            const stories = await storyLoader.loadAll().catch((err) => {
                console.warn(`[GraphEngine] Could not load stories: ${err.message}`);
                return [] as Story[];
            });

            // 3. Build graph from loaded data (shared with worker path)
            const result = await this.buildGraphFromData(peopleWithMtime, stories, fromCache, parsed);

            // 4. Persist binary cache for next boot
            await GraphCache.save(this.cachePath, peopleWithMtime);
            this._cacheWrittenAt = new Date().toISOString();

            // 5. Persist search index for next boot
            // Queued behind any other index write (persist() logs failures itself)
            await this.searchService.persist();

            const elapsedMs = Date.now() - this._hydrationStartTime;
            this.emit('hydration:complete', {
                nodeCount: this.graph.order,
                edgeCount: this.graph.size,
                elapsedMs
            });
            this.emit('graph-updated');

            return result;
        } finally {
            this.watcherSuspended = false;
        }
    }

    /**
     * Hydrate graph in a background Worker Thread (spec Section 2.3B).
     * The server remains responsive while the worker performs heavy I/O.
     * Falls back to inline hydrate() if the worker fails.
     *
     * @param options.forceFullRebuild - Bypass cache and re-parse all YAML files
     * @returns Promise that resolves when hydration is complete
     */
    public async hydrateInBackground(options?: { forceFullRebuild?: boolean }): Promise<HydrationResult> {
        this._hydrationState = 'loading';
        this._hydrationStartTime = Date.now();
        this.watcherSuspended = true;
        console.log(`[GraphEngine] Hydrating graph (worker thread) from: ${this.rootDir}`);

        try {
            const workerResult = await this.runWorker(options?.forceFullRebuild ?? false);
            this.emit('hydration:progress', { phase: 'building', loaded: 0, total: 0, percent: 100 });
            const result = await this.buildGraphFromData(
                workerResult.people,
                workerResult.stories,
                workerResult.fromCache,
                workerResult.parsed
            );
            // Queued behind any other index write (persist() logs failures itself)
            await this.searchService.persist();
            const elapsedMs = Date.now() - this._hydrationStartTime;
            this.emit('hydration:complete', {
                nodeCount: this.graph.order,
                edgeCount: this.graph.size,
                elapsedMs
            });
            this.emit('graph-updated');
            return result;
        } catch (err: any) {
            console.warn(`[GraphEngine] Worker failed, falling back to inline hydration: ${err.message}`);
            // hydrate() manages watcherSuspended itself; reset here before handing off
            this.watcherSuspended = false;
            return this.hydrate(options);
        } finally {
            this.watcherSuspended = false;
        }
    }

    /**
     * Spawn a worker thread to perform heavy I/O (YAML parsing, Zod validation, story loading).
     * Returns the worker's output via postMessage.
     *
     * Uses tsx for TypeScript execution in the worker to handle ESM interop
     * (packages like p-limit v7+ are ESM-only but the project uses CommonJS).
     */
    private runWorker(forceFullRebuild: boolean): Promise<HydrationWorkerResult> {
        return new Promise((resolve, reject) => {
            // Detect TypeScript vs compiled JavaScript context
            const isTS = __filename.endsWith('.ts');
            const workerFile = isTS ? 'HydrationWorker.ts' : 'HydrationWorker.js';
            const workerPath = path.resolve(__dirname, workerFile);

            // tsx handles TypeScript compilation AND ESM/CJS interop in the worker thread
            const execArgv = isTS
                ? ['--require', 'tsx/cjs']
                : [];

            const worker = new Worker(workerPath, {
                workerData: { rootDir: this.rootDir, forceFullRebuild },
                execArgv
            });

            worker.on('message', (msg: HydrationWorkerResult | HydrationWorkerError | HydrationWorkerProgress) => {
                if (msg.type === 'progress') {
                    this.emit('hydration:progress', msg as HydrationWorkerProgress);
                    return;
                }
                worker.terminate();
                if (msg.type === 'error') {
                    reject(new Error((msg as HydrationWorkerError).message));
                } else {
                    resolve(msg as HydrationWorkerResult);
                }
            });

            worker.on('error', (err) => {
                reject(err);
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    reject(new Error(`Worker exited with code ${code}`));
                }
            });
        });
    }

    /**
     * Build the Graphology graph, edges, search index, and _computed cache
     * from pre-loaded data. This is the lightweight "main thread" work that
     * runs after either inline loading or worker thread loading completes.
     */
    private async buildGraphFromData(
        peopleWithMtime: PersonEntry[],
        stories: Story[],
        fromCache: number,
        parsed: number
    ): Promise<HydrationResult> {
        this.graph.clear();
        this.fileMap.clear();
        this.reverseFileMap.clear();

        // 1. Try importing cached search index for incremental indexing
        const searchImport = await this.searchService.importIndex(this.searchIndexPath).catch(() => null);
        const currentPersonIds = new Set(peopleWithMtime.map(e => e.data.id));

        // Bulk indexing below passes skipPersist: hydrate() exports the index itself once
        // done, and a leftover debounce timer would rewrite it ~500ms after hydration.

        // Clean up deleted people from imported index
        if (searchImport) {
            for (const oldId of searchImport.personIds) {
                if (!currentPersonIds.has(oldId)) {
                    this.searchService.removePerson(oldId, true);
                }
            }
        }

        // 2. Add people nodes (Slim Node Strategy: cache/worker already stripped them)
        const slimPeople: SlimPerson[] = [];
        peopleWithMtime.forEach(({ data: slim, bio, filePath, wasParsed }) => {
            this.graph.addNode(slim.id, { type: 'person', data: slim });
            this.fileMap.set(filePath, slim.id);
            this.reverseFileMap.set(slim.id, filePath);
            slimPeople.push(slim);

            // Index: if search cache loaded, only re-index changed entries; otherwise index all
            if (!searchImport || wasParsed !== false) {
                this.searchService.indexPerson(slim, bio, true);
            } else {
                this.searchService.trackPerson(slim.id);
            }
        });

        // 3. Add story nodes + index
        stories.forEach(s => {
            this.graph.addNode(s.id, { type: 'story', data: s });
            if (!searchImport) {
                this.searchService.indexStory(s, true);
            } else {
                this.searchService.trackStory(s.id);
            }
        });

        // 3. Build Lineage Edges (Child -> Parent)
        slimPeople.forEach(p => {
            p.relationships.parents.forEach(parent => {
                if (this.graph.hasNode(parent.id)) {
                    this.graph.addEdge(p.id, parent.id, {
                        type: 'child_of',
                        relType: parent.type
                    });
                } else {
                    console.warn(`[GraphEngine] Orphan Parent Reference: ${p.id} -> ${parent.id}`);
                }
            });
        });

        // 4. Build Narrative Edges (Story -> Mentions)
        stories.forEach(s => {
            s.mentions.forEach(personId => {
                if (this.graph.hasNode(personId)) {
                    this.graph.addEdge(s.id, personId, { type: 'mentions' });
                } else {
                    console.warn(`[GraphEngine] Story ${s.id} mentions missing person: ${personId}`);
                }
            });
        });

        // 5. Compute derived relationships (_computed cache)
        computeAllRelationships(this.graph);

        // 6. Update cache metadata (worker already saved cache; inline path saves after this)
        this._cacheWrittenAt = new Date().toISOString();
        this._hydrationState = 'ready';

        console.log(
            `[GraphEngine] Hydration Complete. Nodes: ${this.graph.order}, Edges: ${this.graph.size}` +
            ` (${fromCache} from cache, ${parsed} parsed)`
        );

        return { fromCache, parsed, total: peopleWithMtime.length };
    }

    /**
     * Full Nuclear Hydration: parse all YAML files via BootLoader, collect mtimes for cache.
     */
    private async loadPeopleFull(): Promise<{
        results: PersonEntry[];
        parsed: number;
    }> {
        const peopleLoader = new BootLoader(path.join(this.rootDir, 'people'));
        const peopleResults = await peopleLoader.loadAll().catch((err) => {
            console.warn(`[GraphEngine] Could not load people: ${err.message}`);
            return [];
        });

        const results: PersonEntry[] = [];
        for (const res of peopleResults) {
            try {
                const stats = await fs.stat(res.filePath);
                results.push({
                    data: toSlimPerson(res.data),
                    bio: res.data.scrapbook_md || '',
                    filePath: res.filePath,
                    mtime: Math.floor(stats.mtimeMs),
                    wasParsed: true
                });
            } catch {
                // File deleted between load and stat — skip
            }
        }

        return { results, parsed: results.length };
    }

    /**
     * Incremental Hydration: compare file mtimes against cache, only re-parse stale files.
     */
    private async loadPeopleIncremental(cache: GraphCacheFile): Promise<{
        results: PersonEntry[];
        fromCache: number;
        parsed: number;
    }> {
        const peopleDir = path.join(this.rootDir, 'people');
        const pattern = path.join(peopleDir, '*.yaml').replace(/\\/g, '/');
        const files = await fg(pattern).catch(() => [] as string[]);

        const results: PersonEntry[] = [];
        let fromCache = 0;
        let parsed = 0;

        const limit = pLimit(50);

        await Promise.all(files.map(file => limit(async () => {
            try {
                const stats = await fs.stat(file);
                const mtime = Math.floor(stats.mtimeMs);
                const cacheEntry = cache.entries[file];

                if (cacheEntry && cacheEntry.mtime === mtime) {
                    // Cache hit — use pre-validated data
                    results.push({
                        data: cacheEntry.data,
                        bio: cacheEntry.bio,
                        filePath: file,
                        mtime,
                        wasParsed: false
                    });
                    fromCache++;
                } else {
                    // Cache miss — parse from YAML + Zod validate
                    const content = await fs.readFile(file, 'utf8');
                    const raw = loadYaml(content);
                    const data = PersonSchema.parse(raw);
                    results.push({
                        data: toSlimPerson(data),
                        bio: data.scrapbook_md || '',
                        filePath: file,
                        mtime,
                        wasParsed: true
                    });
                    parsed++;
                }
            } catch (err: any) {
                console.warn(`[GraphEngine] Failed to process ${file}: ${err.message}`);
            }
        })));

        return { results, fromCache, parsed };
    }

    private peopleWatcherSubscription: AsyncSubscription | null = null;
    private storyWatcherSubscription: AsyncSubscription | null = null;

    /**
     * Starts File System Watchers using @parcel/watcher (native OS APIs).
     * Watches both `people/` (YAML) and `stories/` (Markdown) directories.
     */
    public async startWatcher(): Promise<void> {
        const peoplePath = path.join(this.rootDir, 'people');
        const storiesPath = path.join(this.rootDir, 'stories');
        console.log(`[GraphEngine] Starting FS Watcher on ${peoplePath}...`);

        this.peopleWatcherSubscription = await watcher.subscribe(
            peoplePath,
            (err, events) => {
                if (err) {
                    console.error('[GraphEngine] People watcher error:', err);
                    return;
                }

                if (this.watcherSuspended || Date.now() < this.watcherSuspendedUntil) return;

                const now = Date.now();
                if (now - this.watcherWindowStart > 500) {
                    this.watcherWindowStart = now;
                    this.watcherEventCount = 0;
                }

                // Only count external events toward circuit breaker (skip self-writes
                // from TransactionManager to avoid tripping during batch operations)
                const externalCount = events.filter(e => !this.hasSelfWrite(e.path)).length;
                this.watcherEventCount += externalCount;

                if (this.watcherEventCount > 50) {
                    console.warn(`[GraphEngine] Circuit breaker triggered! ${this.watcherEventCount} external events in <500ms.`);
                    this.triggerCircuitBreaker();
                    return;
                }

                for (const event of events) {
                    if (!event.path.endsWith('.yaml')) continue;
                    if (path.basename(event.path).startsWith('.')) continue;

                    switch (event.type) {
                        case 'create':
                        case 'update':
                            this.handleFileUpdate(event.path);
                            break;
                        case 'delete':
                            this.handleFileRemove(event.path);
                            break;
                    }
                }
            },
            { ignore: ['.*', '**/.git/**'] }
        );

        try {
            await fs.access(storiesPath);
            this.storyWatcherSubscription = await watcher.subscribe(
                storiesPath,
                (err, events) => {
                    if (err) {
                        console.error('[GraphEngine] Story watcher error:', err);
                        return;
                    }

                    if (this.watcherSuspended || Date.now() < this.watcherSuspendedUntil) return;

                    const now = Date.now();
                    if (now - this.watcherWindowStart > 500) {
                        this.watcherWindowStart = now;
                        this.watcherEventCount = 0;
                    }

                    // Only count external events toward circuit breaker
                    const externalCount = events.filter(e => !this.hasSelfWrite(e.path)).length;
                    this.watcherEventCount += externalCount;

                    if (this.watcherEventCount > 50) {
                        console.warn(`[GraphEngine] Circuit breaker triggered! ${this.watcherEventCount} external events in <500ms.`);
                        this.triggerCircuitBreaker();
                        return;
                    }

                    for (const event of events) {
                        if (!event.path.endsWith('.md')) continue;
                        if (path.basename(event.path).startsWith('.')) continue;

                        switch (event.type) {
                            case 'create':
                            case 'update':
                                this.handleStoryUpdate(event.path);
                                break;
                            case 'delete':
                                this.handleStoryRemove(event.path);
                                break;
                        }
                    }
                },
                { ignore: ['.*', '**/.git/**'] }
            );
        } catch {
            // stories/ directory may not exist yet
        }
    }

    private triggerCircuitBreaker() {
        this.watcherSuspended = true;
        this._hydrationState = 'loading';
        console.log('[GraphEngine] Suspending hot-patching and initiating background re-hydration...');

        this.hydrateInBackground({ forceFullRebuild: false })
            .then(() => {
                console.log('[GraphEngine] Circuit breaker resolved. Resuming hot-patching.');
            })
            .catch(err => {
                console.error('[GraphEngine] Circuit breaker re-hydration failed:', err);
            })
            .finally(() => {
                this.watcherSuspended = false;
                this.watcherEventCount = 0;
            });
    }

    /**
     * Suspend the watcher during a batch write operation.
     * The apply handler already updates the graph in-memory, so watcher events
     * for self-writes are redundant. Suspending avoids race conditions where
     * FSEvents delivers callbacks before self-write registration completes.
     */
    public async withSuspendedWatcher<T>(fn: () => Promise<T>): Promise<T> {
        const wasSuspended = this.watcherSuspended;
        this.watcherSuspended = true;
        try {
            return await fn();
        } finally {
            if (!wasSuspended) {
                // FSEvents delivers callbacks asynchronously — events generated during
                // suspension may arrive after we set watcherSuspended back to false.
                // Set a 2-second grace period so those late-arriving events are still ignored.
                this.watcherSuspendedUntil = Date.now() + 2000;
                this.watcherSuspended = false;
                this.watcherEventCount = 0;
            }
        }
    }

    /**
     * Shut down: stop the watchers and flush the debounced search-index write, so the
     * latest index is saved and nothing writes into the data dir after this resolves.
     * Safe to call multiple times.
     */
    public async close(): Promise<void> {
        await this.stopWatcher();
        await this.searchService.flushPendingPersist();
    }

    /**
     * Stops all file system watchers and cleans up subscriptions.
     * Safe to call multiple times (no-op if no active subscription).
     */
    public async stopWatcher(): Promise<void> {
        if (this.peopleWatcherSubscription) {
            await this.peopleWatcherSubscription.unsubscribe();
            this.peopleWatcherSubscription = null;
        }
        if (this.storyWatcherSubscription) {
            await this.storyWatcherSubscription.unsubscribe();
            this.storyWatcherSubscription = null;
        }
    }

    /**
     * Apply all write-path side effects for a person node: edge reconciliation,
     * search indexing, and _computed invalidation. Called by both the API write
     * handlers and the file watcher hot-patch path to ensure consistency.
     *
     * @param id - Person ID
     * @param oldSlim - Previous slim data (null for new nodes)
     * @param newSlim - New slim data already set on the graph node
     * @param bio - Scrapbook markdown for search indexing
     */
    public applyWriteSideEffects(id: string, oldSlim: SlimPerson | null, newSlim: SlimPerson, bio: string): void {
        if (oldSlim) {
            this.reconcileEdges(id, oldSlim, newSlim);
        } else {
            this.addParentEdges(newSlim);
        }

        this.searchService.indexPerson(newSlim, bio);
        invalidateComputed(this.graph, id);
        this.emit('graph-updated');
    }

    private async handleFileUpdate(filePath: string) {
        // Write-event deduplication: skip if this change was made by the application itself.
        // Consume the entry so that external edits after a short grace window are not ignored.
        // Re-register with a brief TTL (1s) to absorb duplicate FSEvents for the same write.
        if (this.consumeSelfWrite(filePath)) {
            this.registerSelfWrite(filePath, 1000);
            return;
        }

        try {
            const content = await fs.readFile(filePath, 'utf8');
            const rawLoaded = loadYaml(content);
            const raw: Record<string, unknown> = (rawLoaded && typeof rawLoaded === 'object')
                ? rawLoaded as Record<string, unknown>
                : {};

            // Auto-ID: if the file has no id (e.g. user dropped a handwritten YAML),
            // generate one, fill in required metadata, write the file back, and rename it.
            if (!raw.id) {
                const now = new Date().toISOString();
                if (!raw.version) raw.version = '5.0';
                if (!raw.created) raw.created = now;
                if (!raw.last_modified) raw.last_modified = now;
                if (!raw.relationships) raw.relationships = { parents: [] };
                if (!raw.tags) raw.tags = [];
                if (!raw.events) raw.events = [];
                if (!raw.assets) raw.assets = [];

                const newId = generatePersonId(raw as any);
                raw.id = newId;

                const newFilename = `${newId}.yaml`;
                const newFilePath = path.join(path.dirname(filePath), newFilename);

                // Register both paths before any writes so the watcher ignores them
                this.registerSelfWrite(filePath);
                this.registerSelfWrite(newFilePath);

                await fs.writeFile(filePath, dumpYaml(raw));
                await fs.rename(filePath, newFilePath);
                filePath = newFilePath;

                console.log(`[GraphEngine] Auto-ID: assigned ${newId} and renamed to ${newFilename}`);
            }

            const newPerson = PersonSchema.parse(raw);
            const slim = toSlimPerson(newPerson);

            // Handle ID changes (rare): treat as remove old + add new
            const existingId = this.fileMap.get(filePath);
            if (existingId && existingId !== newPerson.id) {
                this.removeNode(existingId);
            }

            // Capture old state before updating the node (already slim in graph)
            let oldData: SlimPerson | null = null;
            if (this.graph.hasNode(newPerson.id)) {
                oldData = this.graph.getNodeAttributes(newPerson.id).data as SlimPerson;
            }

            // Update (or create) graph node with slim data
            if (this.graph.hasNode(newPerson.id)) {
                this.graph.mergeNodeAttributes(newPerson.id, { data: slim });
            } else {
                this.graph.addNode(newPerson.id, { type: 'person', data: slim });
            }
            this.fileMap.set(filePath, newPerson.id);
            this.reverseFileMap.set(newPerson.id, filePath);

            this.applyWriteSideEffects(newPerson.id, oldData, slim, newPerson.scrapbook_md || '');

        } catch (err: any) {
            console.error(`[GraphEngine] Failed to hot-patch ${filePath}: ${err.message}`);
        }
    }

    /**
     * Diff-Based Edge Reconciliation (spec 4.1).
     * Compares old vs. new parent references and applies minimal edge changes.
     * Falls back to drop-all-and-rebuild if the diff produces an inconsistent state.
     */
    private reconcileEdges(nodeId: string, oldPerson: SlimPerson, newPerson: SlimPerson): void {
        try {
            const oldParentIds = new Set(oldPerson.relationships.parents.map(p => p.id));
            const newParentIds = new Set(newPerson.relationships.parents.map(p => p.id));
            const newParentMap = new Map(newPerson.relationships.parents.map(p => [p.id, p]));
            const oldParentMap = new Map(oldPerson.relationships.parents.map(p => [p.id, p]));

            // 1. Remove edges for dropped parents
            for (const oldParentId of oldParentIds) {
                if (!newParentIds.has(oldParentId)) {
                    const edges = this.graph.outEdges(nodeId).filter(edge => {
                        const attrs = this.graph.getEdgeAttributes(edge);
                        return attrs.type === 'child_of' && this.graph.target(edge) === oldParentId;
                    });
                    edges.forEach(edge => this.graph.dropEdge(edge));
                }
            }

            // 2. Add edges for new parents
            for (const newParentId of newParentIds) {
                if (!oldParentIds.has(newParentId)) {
                    if (this.graph.hasNode(newParentId)) {
                        const parent = newParentMap.get(newParentId)!;
                        this.graph.addEdge(nodeId, newParentId, {
                            type: 'child_of',
                            relType: parent.type
                        });
                    }
                }
            }

            // 3. Handle relationship type changes for retained parents
            for (const parentId of newParentIds) {
                if (oldParentIds.has(parentId)) {
                    const newParent = newParentMap.get(parentId)!;
                    const oldParent = oldParentMap.get(parentId)!;
                    if (oldParent.type !== newParent.type) {
                        const edge = this.graph.outEdges(nodeId).find(e => {
                            const attrs = this.graph.getEdgeAttributes(e);
                            return attrs.type === 'child_of' && this.graph.target(e) === parentId;
                        });
                        if (edge) {
                            this.graph.setEdgeAttribute(edge, 'relType', newParent.type);
                        }
                    }
                }
            }
        } catch (err: any) {
            // Fallback: mini-hydration (drop all child_of edges and rebuild)
            console.warn(`[GraphEngine] Edge diff failed for ${nodeId}, falling back to mini-hydration: ${err.message}`);
            this.fallbackRebuildEdges(nodeId, newPerson);
        }
    }

    /**
     * Mini-hydration fallback: drops all outgoing child_of edges and rebuilds from scratch.
     * Used when diff-based reconciliation detects an inconsistent state.
     */
    private fallbackRebuildEdges(nodeId: string, person: SlimPerson): void {
        if (this.graph.hasNode(nodeId)) {
            const edgesToDrop = this.graph.outEdges(nodeId).filter(edge =>
                this.graph.getEdgeAttributes(edge).type === 'child_of'
            );
            edgesToDrop.forEach(edge => this.graph.dropEdge(edge));
        }
        this.addParentEdges(person);
    }

    /**
     * Add child_of edges for all of a person's parents.
     */
    private addParentEdges(person: SlimPerson): void {
        person.relationships.parents.forEach(parent => {
            if (this.graph.hasNode(parent.id)) {
                this.graph.addEdge(person.id, parent.id, {
                    type: 'child_of',
                    relType: parent.type
                });
            }
        });
    }

    private handleFileRemove(filePath: string) {
        // Write-event deduplication: skip if this change was made by the application itself
        if (this.consumeSelfWrite(filePath)) {
            this.registerSelfWrite(filePath, 1000);
            return;
        }

        const id = this.fileMap.get(filePath);
        if (id) {
            this.removeNode(id);
            this.fileMap.delete(filePath);
            this.reverseFileMap.delete(id);
            console.log(`[GraphEngine] Hot-removed ${id}`);
        }
    }

    private removeNode(id: string) {
        if (this.graph.hasNode(id)) {
            this.graph.dropNode(id);
            this.searchService.removePerson(id);
            this.emit('graph-updated');
        }
    }

    /**
     * Parse a single story markdown file into a Story object.
     * Extracts frontmatter, content, and @N_xxx / [[N_xxx]] mentions.
     */
    private async parseSingleStory(filePath: string): Promise<Story> {
        const raw = await fs.readFile(filePath, 'utf8');
        const { data, content } = matter(raw);
        const metadata = StorySchema.parse(data);

        const mentions = new Set<string>();
        remark().use(() => (tree: any) => {
            visit(tree, 'text', (node: any) => {
                const regex = /(@N_[a-zA-Z0-9_-]+)|(\[\[(N_[a-zA-Z0-9_-]+)\]\])/g;
                let match;
                while ((match = regex.exec(node.value)) !== null) {
                    const id = match[1] || match[3];
                    if (id) mentions.add(id.replace('@', ''));
                }
            });
        }).processSync(content);

        return {
            id: path.basename(filePath),
            metadata,
            content,
            mentions: Array.from(mentions)
        };
    }

    /**
     * Immediately update the graph for an API-written story file.
     * Call this after writing a story via the API so the graph reflects the change
     * without waiting for the file watcher. Also registers as a self-write so the
     * watcher does not double-process the file.
     */
    public async applyStoryWriteSideEffects(filePath: string): Promise<void> {
        this.registerSelfWrite(filePath);
        await this.handleStoryUpdateCore(filePath);
    }

    private async handleStoryUpdate(filePath: string): Promise<void> {
        if (this.consumeSelfWrite(filePath)) {
            this.registerSelfWrite(filePath, 1000);
            return;
        }
        await this.handleStoryUpdateCore(filePath);
    }

    private async handleStoryUpdateCore(filePath: string): Promise<void> {

        try {
            const story = await this.parseSingleStory(filePath);
            const storyId = story.id;

            // Remove old mentions edges if story already exists
            if (this.graph.hasNode(storyId)) {
                const oldEdges = this.graph.outEdges(storyId);
                oldEdges.forEach(edge => this.graph.dropEdge(edge));
                this.graph.mergeNodeAttributes(storyId, { data: story });
            } else {
                this.graph.addNode(storyId, { type: 'story', data: story });
            }

            // Add mentions edges to referenced persons
            for (const personId of story.mentions) {
                if (this.graph.hasNode(personId)) {
                    this.graph.addEdge(storyId, personId, { type: 'mentions' });
                }
            }

            this.searchService.indexStory(story);

            // Invalidate _computed for mentioned persons (timeline changes)
            for (const personId of story.mentions) {
                if (this.graph.hasNode(personId)) {
                    invalidateComputed(this.graph, personId);
                }
            }
            this.emit('graph-updated');
        } catch (err: any) {
            console.error(`[GraphEngine] Failed to hot-patch story ${filePath}: ${err.message}`);
        }
    }

    /**
     * Handle story file deletion from the watcher or direct invocation.
     * Removes story node, edges, and search index entry.
     */
    /**
     * Immediately update the graph for an API-deleted story file.
     * Call this after deleting a story via the API so the graph reflects the change
     * without waiting for the file watcher. Also registers as a self-write so the
     * watcher does not double-process the deletion.
     */
    public applyStoryDeleteSideEffects(filePath: string): void {
        this.registerSelfWrite(filePath);
        const storyId = path.basename(filePath);
        if (this.graph.hasNode(storyId)) {
            const mentionedPersons = this.graph.outNeighbors(storyId);
            this.graph.dropNode(storyId);
            this.searchService.removeStory(storyId);
            for (const personId of mentionedPersons) {
                if (this.graph.hasNode(personId)) {
                    invalidateComputed(this.graph, personId);
                }
            }
            this.emit('graph-updated');
        }
    }

    private handleStoryRemove(filePath: string): void {
        if (this.consumeSelfWrite(filePath)) {
            this.registerSelfWrite(filePath, 1000);
            return;
        }

        const storyId = path.basename(filePath);
        if (this.graph.hasNode(storyId)) {
            // Capture mentioned persons before removing for _computed invalidation
            const mentionedPersons = this.graph.outNeighbors(storyId);
            this.graph.dropNode(storyId);
            this.searchService.removeStory(storyId);

            for (const personId of mentionedPersons) {
                if (this.graph.hasNode(personId)) {
                    invalidateComputed(this.graph, personId);
                }
            }
            this.emit('graph-updated');
        }
    }
}