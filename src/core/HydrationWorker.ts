// src/core/HydrationWorker.ts
//
// Worker Thread Hydration (spec Section 2.3B).
// This module runs the heavy I/O work (YAML parsing, Zod validation, story loading)
// either inside a worker_threads Worker or directly on the main thread when called
// via the exported `runHydrationWorker()` function.

import { parentPort, workerData, isMainThread } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs/promises';
import fg from 'fast-glob';
import pLimit from 'p-limit';
import { loadYaml } from './yaml';
import { PersonSchema, SlimPerson, PersonEntry, toSlimPerson } from '../schemas/PersonSchema';
import { StoryLoader, Story } from './StoryLoader';
import { GraphCache, GraphCacheFile } from './GraphCache';
import { BootLoader } from './BootLoader';

export interface HydrationWorkerInput {
    rootDir: string;
    forceFullRebuild: boolean;
}


export interface HydrationWorkerResult {
    type: 'success';
    people: PersonEntry[];
    stories: Story[];
    fromCache: number;
    parsed: number;
}

export interface HydrationWorkerProgress {
    type: 'progress';
    phase: string;
    loaded: number;
    total: number;
    percent: number;
}

export interface HydrationWorkerError {
    type: 'error';
    message: string;
}

/**
 * Core hydration logic — performs all heavy I/O work:
 * 1. Loads/validates cache
 * 2. Globs + stats YAML files
 * 3. Parses stale files via Zod
 * 4. Loads stories
 * 5. Saves updated cache
 *
 * Can be called directly (for unit testing) or via worker_threads (for production).
 */
export async function runHydrationWorker(input: HydrationWorkerInput): Promise<HydrationWorkerResult> {
    const { rootDir, forceFullRebuild } = input;
    const cachePath = path.join(rootDir, '_meta', '.graph-cache.json');

    // Load cache (unless forced rebuild)
    const cache = forceFullRebuild ? null : await GraphCache.load(cachePath);

    let people: PersonEntry[];
    let fromCache = 0;
    let parsed = 0;

    if (cache) {
        const result = await loadPeopleIncremental(rootDir, cache);
        people = result.results;
        fromCache = result.fromCache;
        parsed = result.parsed;
    } else {
        const result = await loadPeopleFull(rootDir);
        people = result.results;
        parsed = result.parsed;
    }

    // Load stories
    const storiesDir = path.join(rootDir, 'stories');
    const storyLoader = new StoryLoader(storiesDir);
    const stories = await storyLoader.loadAll().catch(() => [] as Story[]);

    // Save cache so next boot benefits from incremental loading
    await GraphCache.save(cachePath, people);

    return {
        type: 'success',
        people,
        stories,
        fromCache,
        parsed
    };
}

/**
 * Full Nuclear Hydration: parse all YAML files via BootLoader, collect mtimes.
 */
function emitProgress(phase: string, loaded: number, total: number): void {
    if (!isMainThread && parentPort) {
        const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
        parentPort.postMessage({
            type: 'progress',
            phase,
            loaded,
            total,
            percent
        } as HydrationWorkerProgress);
    }
}

async function loadPeopleFull(rootDir: string): Promise<{
    results: PersonEntry[];
    parsed: number;
}> {
    const peopleLoader = new BootLoader(path.join(rootDir, 'people'));
    const peopleResults = await peopleLoader.loadAll().catch(() => []);

    const results: PersonEntry[] = [];
    const total = peopleResults.length;
    for (let i = 0; i < peopleResults.length; i++) {
        const res = peopleResults[i];
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
        if ((i + 1) % 50 === 0 || i === total - 1) {
            emitProgress('parsing', i + 1, total);
        }
    }

    return { results, parsed: results.length };
}

/**
 * Incremental Hydration: compare file mtimes against cache, only re-parse stale files.
 */
async function loadPeopleIncremental(rootDir: string, cache: GraphCacheFile): Promise<{
    results: PersonEntry[];
    fromCache: number;
    parsed: number;
}> {
    const peopleDir = path.join(rootDir, 'people');
    const pattern = path.join(peopleDir, '*.yaml').replace(/\\/g, '/');
    const files = await fg(pattern).catch(() => [] as string[]);

    const results: PersonEntry[] = [];
    let fromCache = 0;
    let parsed = 0;

    const limit = pLimit(50);
    const total = files.length;
    let processed = 0;

    await Promise.all(files.map(file => limit(async () => {
        try {
            const stats = await fs.stat(file);
            const mtime = Math.floor(stats.mtimeMs);
            const cacheEntry = cache.entries[file];

            if (cacheEntry && cacheEntry.mtime === mtime) {
                results.push({
                    data: cacheEntry.data as SlimPerson,
                    bio: cacheEntry.bio,
                    filePath: file,
                    mtime,
                    wasParsed: false
                });
                fromCache++;
            } else {
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
        } catch (err: unknown) {
            console.warn(`[HydrationWorker] Failed to process ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
        processed++;
        if (processed % 50 === 0 || processed === total) {
            emitProgress('loading', processed, total);
        }
    })));

    return { results, fromCache, parsed };
}

// Worker entry point — only executes when loaded as a worker thread (not when imported for types/functions)
if (!isMainThread && parentPort) {
    const input = workerData as HydrationWorkerInput;
    runHydrationWorker(input)
        .then(result => parentPort!.postMessage(result))
        .catch(err => parentPort!.postMessage({
            type: 'error',
            message: err instanceof Error ? err.message : String(err)
        } as HydrationWorkerError));
}
