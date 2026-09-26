import { FastifyInstance } from 'fastify';
import * as path from 'path';
import * as fs from 'fs/promises';
import { dumpYaml } from '../../core/yaml';
import type { AppInstance } from '../types';
import type { Place } from '../../schemas/PlaceSchema';
import type { SlimPerson } from '../../schemas/PersonSchema';
import { PersonSchema, toSlimPerson } from '../../schemas/PersonSchema';
import type { JobProgress } from '../../core/JobManager';

// ── Shared types ─────────────────────────────────────────────────────────────

interface BatchGeocodeOccurrence {
    personId: string;
    personName: string;
    eventId: string;
    eventType: string;
}

interface BatchGeocodeResult {
    locationString: string;
    occurrences: BatchGeocodeOccurrence[];
    match: {
        place: Place;
        confidence: 'high' | 'medium' | 'low';
        siteName: string | null;
    } | null;
}

interface BatchGeocodeStats {
    total: number;
    high: number;
    medium: number;
    low: number;
    unmatched: number;
    alreadyResolved: number;
}

interface ApplyUpdate {
    locationString: string;
    place: Place;
    siteName: string | null;
}

interface PersistedBatchGeocodeState {
    version: 1;
    completedAt: string;
    results: BatchGeocodeResult[];
    stats: BatchGeocodeStats;
    selections: {
        checked: string[];
        filter: string;
        searchQuery: string;
        sortBy?: string;
        sortOrder?: string;
        overrides?: Record<string, { place: Place; siteName: string | null }>;
    };
}

const JOB_TYPE = 'batch-geocode';

// -- Persistence helpers ------------------------------------------------------

function resultsPath(dataDir: string): string {
    return path.join(dataDir, '_meta', '.batch-geocode-results.json');
}

async function loadPersistedResults(dataDir: string): Promise<PersistedBatchGeocodeState | null> {
    try {
        const raw = await fs.readFile(resultsPath(dataDir), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function persistResults(dataDir: string, state: PersistedBatchGeocodeState): Promise<void> {
    await fs.mkdir(path.join(dataDir, '_meta'), { recursive: true });
    await fs.writeFile(resultsPath(dataDir), JSON.stringify(state));
}

async function clearPersistedResults(dataDir: string): Promise<void> {
    try {
        await fs.unlink(resultsPath(dataDir));
    } catch {
        // Ignore if not found
    }
}

// ── Route plugin ─────────────────────────────────────────────────────────────

export async function geocodingRoutes(server: FastifyInstance) {
    const { graphEngine, txManager, geocodingService, jobManager, dataDir } = (server as AppInstance).appServices;

    // POST /api/geocoding/batch/start — kick off background scan
    server.post('/api/geocoding/batch/start', async (_request, _reply) => {
        const existing = jobManager.getByType(JOB_TYPE);

        // If a job is already running, return its ID
        if (existing && existing.status === 'running') {
            return { jobId: existing.id, status: 'running' };
        }

        // If completed results exist on disk, indicate that
        const persisted = await loadPersistedResults(dataDir);
        if (persisted) {
            return { jobId: null, status: 'completed' };
        }

        // Start the background scan
        const jobId = jobManager.start<{ results: BatchGeocodeResult[]; stats: BatchGeocodeStats }>(
            JOB_TYPE,
            async (emit: (progress: JobProgress) => void) => {
                const graph = graphEngine.getGraph();

                // Collect all unresolved locations with their occurrences
                const locationMap = new Map<string, BatchGeocodeOccurrence[]>();
                let alreadyResolved = 0;

                graph.forEachNode((nodeId, attributes) => {
                    if (attributes.type !== 'person') return;
                    const slim = attributes.data as SlimPerson;
                    if (!slim.events) return;

                    const primaryName = slim.names?.[0];
                    const personName = primaryName
                        ? [primaryName.first, primaryName.last].filter(Boolean).join(' ')
                        : nodeId;

                    for (const event of slim.events) {
                        if (!event.location) continue;
                        if (event.location.resolvedAt) {
                            alreadyResolved++;
                            continue;
                        }
                        const locStr = event.location.name;
                        if (!locStr || !locStr.trim()) continue;

                        const occurrences = locationMap.get(locStr) || [];
                        occurrences.push({
                            personId: nodeId,
                            personName,
                            eventId: event.id,
                            eventType: event.type,
                        });
                        locationMap.set(locStr, occurrences);
                    }
                });

                // Geocode each unique location string
                const results: BatchGeocodeResult[] = [];
                const stats: BatchGeocodeStats = {
                    total: locationMap.size,
                    high: 0,
                    medium: 0,
                    low: 0,
                    unmatched: 0,
                    alreadyResolved,
                };

                let processed = 0;
                const total = locationMap.size;

                for (const [locStr, occurrences] of locationMap) {
                    const searchResult = await geocodingService.searchWithMetadata(locStr);

                    if (!searchResult.place || searchResult.confidence === 'none') {
                        stats.unmatched++;
                        results.push({ locationString: locStr, occurrences, match: null });
                    } else {
                        const conf = searchResult.confidence;
                        stats[conf]++;
                        const siteName = searchResult.droppedParts.length > 0
                            ? searchResult.droppedParts.join(', ')
                            : null;
                        results.push({
                            locationString: locStr,
                            occurrences,
                            match: { place: searchResult.place, confidence: conf, siteName },
                        });
                    }

                    processed++;
                    emit({ processed, total, percent: total > 0 ? Math.round((processed / total) * 100) : 100 });
                }

                // Auto-select high and medium confidence matches
                const checked = results
                    .filter(r => r.match && (r.match.confidence === 'high' || r.match.confidence === 'medium'))
                    .map(r => r.locationString);

                // Persist to disk
                await persistResults(dataDir, {
                    version: 1,
                    completedAt: new Date().toISOString(),
                    results,
                    stats,
                    selections: { checked, filter: 'all', searchQuery: '' },
                });

                return { results, stats };
            },
        );

        return { jobId, status: 'running' };
    });

    // GET /api/geocoding/batch/stream — SSE progress stream
    server.get('/api/geocoding/batch/stream', async (request, reply) => {
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        const job = jobManager.getByType(JOB_TYPE);

        // If no running job, check persisted results
        if (!job || job.status !== 'running') {
            const persisted = await loadPersistedResults(dataDir);
            if (persisted) {
                reply.raw.write(`event: complete\ndata: ${JSON.stringify({ results: persisted.results, stats: persisted.stats })}\n\n`);
            } else if (job && job.status === 'completed') {
                reply.raw.write(`event: complete\ndata: ${JSON.stringify(job.result)}\n\n`);
            } else if (job && job.status === 'failed') {
                reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: job.error })}\n\n`);
            } else {
                reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: 'No batch geocoding job found' })}\n\n`);
            }
            reply.raw.end();
            return;
        }

        // Stream progress from the running job
        const onProgress = (data: { jobId: string } & JobProgress) => {
            if (data.jobId !== job.id) return;
            reply.raw.write(`event: progress\ndata: ${JSON.stringify(data)}\n\n`);
        };

        const onComplete = (data: { jobId: string; result: unknown }) => {
            if (data.jobId !== job.id) return;
            reply.raw.write(`event: complete\ndata: ${JSON.stringify(data.result)}\n\n`);
            reply.raw.end();
            cleanup();
        };

        const onError = (data: { jobId: string; error: string }) => {
            if (data.jobId !== job.id) return;
            reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: data.error })}\n\n`);
            reply.raw.end();
            cleanup();
        };

        const cleanup = () => {
            jobManager.removeListener('job:progress', onProgress);
            jobManager.removeListener('job:complete', onComplete);
            jobManager.removeListener('job:error', onError);
        };

        jobManager.on('job:progress', onProgress);
        jobManager.on('job:complete', onComplete);
        jobManager.on('job:error', onError);

        request.raw.on('close', cleanup);
    });

    // GET /api/geocoding/batch/results — retrieve persisted results + selections
    server.get('/api/geocoding/batch/results', async (_request, reply) => {
        const persisted = await loadPersistedResults(dataDir);
        if (!persisted) {
            // Check if a job is currently running
            const job = jobManager.getByType(JOB_TYPE);
            if (job && job.status === 'running') {
                return reply.status(202).send({ status: 'running', progress: job.progress });
            }
            return reply.status(404).send({ error: 'No batch geocoding results found', code: 'NOT_FOUND' });
        }
        return persisted;
    });

    // PUT /api/geocoding/batch/selections — persist user's check/filter/search state
    server.put<{ Body: { checked: string[]; filter: string; searchQuery: string; sortBy?: string; sortOrder?: string; overrides?: Record<string, { place: Place; siteName: string | null }> } }>(
        '/api/geocoding/batch/selections',
        async (request, reply) => {
            const persisted = await loadPersistedResults(dataDir);
            if (!persisted) {
                return reply.status(404).send({ error: 'No batch geocoding results found', code: 'NOT_FOUND' });
            }

            const { checked, filter, searchQuery, sortBy, sortOrder, overrides } = request.body ?? {};
            persisted.selections = {
                checked: checked ?? persisted.selections.checked,
                filter: filter ?? persisted.selections.filter,
                searchQuery: searchQuery ?? persisted.selections.searchQuery,
                sortBy: sortBy ?? persisted.selections.sortBy,
                sortOrder: sortOrder ?? persisted.selections.sortOrder,
                overrides: overrides ?? persisted.selections.overrides,
            };
            await persistResults(dataDir, persisted);
            return { ok: true };
        },
    );

    // DELETE /api/geocoding/batch/results — clear persisted results
    server.delete('/api/geocoding/batch/results', async () => {
        await clearPersistedResults(dataDir);
        jobManager.clear(JOB_TYPE);
        return { ok: true };
    });

    // POST /api/geocoding/batch/apply — apply confirmed geocoding results (unchanged logic)
    server.post<{ Body: { updates: ApplyUpdate[] } }>('/api/geocoding/batch/apply', async (request, reply) => {
        const { updates } = request.body ?? {};

        if (!updates || !Array.isArray(updates) || updates.length === 0) {
            return reply.status(400).send({
                error: 'Request body must include a non-empty "updates" array',
                code: 'VALIDATION_ERROR',
            });
        }

        const graph = graphEngine.getGraph();

        // Build lookup: locationString → update
        const updateMap = new Map<string, ApplyUpdate>();
        for (const u of updates) {
            updateMap.set(u.locationString, u);
        }

        // Find all people affected by these updates
        const affectedPeople = new Map<string, Set<string>>();
        graph.forEachNode((nodeId, attributes) => {
            if (attributes.type !== 'person') return;
            const slim = attributes.data as SlimPerson;
            if (!slim.events) return;

            for (const event of slim.events) {
                if (!event.location) continue;
                if (event.location.resolvedAt) continue;

                const locStr = event.location.name;
                if (updateMap.has(locStr)) {
                    const set = affectedPeople.get(nodeId) || new Set();
                    set.add(locStr);
                    affectedPeople.set(nodeId, set);
                }
            }
        });

        let updatedPeople = 0;
        let eventsUpdated = 0;

        // Suspend the file watcher during batch writes. The graph is updated
        // in-memory below, so watcher events for these writes are redundant.
        // Without suspension, the burst of file writes trips the circuit breaker
        // (FSEvents delivers hundreds of events), which sets hydrationState to
        // 'loading' and causes subsequent requests to 503.
        const result = await graphEngine.withSuspendedWatcher(async () => {
            for (const [personId, locationStrings] of affectedPeople) {
                if (!graph.hasNode(personId)) continue;

                const oldSlim = graph.getNodeAttributes(personId).data as SlimPerson;
                const heavyFields = await graphEngine.loadHeavyFields(personId);
                if (!heavyFields) continue;

                const currentPerson = {
                    ...oldSlim,
                    scrapbook_md: heavyFields.scrapbook_md ?? '',
                    _gedcom: heavyFields._gedcom ?? {},
                };

                const gedcom = currentPerson._gedcom as Record<string, unknown>;
                if (!gedcom.original_locations) {
                    gedcom.original_locations = {};
                }

                let personModified = false;

                for (const event of currentPerson.events) {
                    if (!event.location) continue;
                    if (event.location.resolvedAt) continue;

                    const locStr = event.location.name;
                    if (!locationStrings.has(locStr)) continue;

                    const update = updateMap.get(locStr)!;

                    (gedcom.original_locations as Record<string, string>)[event.id] = locStr;

                    event.location = update.place;
                    if (!event.location.resolvedAt) {
                        event.location.resolvedAt = new Date().toISOString();
                    }

                    if (update.siteName && !event.site_name) {
                        event.site_name = update.siteName;
                    }

                    personModified = true;
                    eventsUpdated++;
                }

                if (personModified) {
                    currentPerson.last_modified = new Date().toISOString();
                    PersonSchema.parse(currentPerson);

                    const relativePath = path.join('people', `${personId}.yaml`);
                    const primaryName = currentPerson.names?.[0];
                    const label = primaryName
                        ? `${primaryName.first} ${primaryName.last}`
                        : personId;
                    await txManager.writeFile(relativePath, dumpYaml(currentPerson), label);

                    const newSlim = toSlimPerson(currentPerson);
                    graph.setNodeAttribute(personId, 'data', newSlim);
                    graphEngine.applyWriteSideEffects(personId, oldSlim, newSlim, currentPerson.scrapbook_md || '');

                    updatedPeople++;
                }
            }

            return { updated: updatedPeople, eventsUpdated };
        });

        // Clear persisted results after successful apply
        await clearPersistedResults(dataDir);
        jobManager.clear(JOB_TYPE);

        return result;
    });
}
