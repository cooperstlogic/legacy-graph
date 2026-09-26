import { FastifyInstance } from 'fastify';
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadYaml, dumpYaml } from '../../core/yaml';
import { GedcomReader } from '../../core/gedcom/Import';
import type { AppInstance } from '../types';
import type { Person } from '../../schemas/PersonSchema';

function buildDedupKey(person: unknown): string | null {
    const p = person as Record<string, unknown>;
    const names = p.names as Array<{ primary?: boolean; first?: string; last?: string }> | undefined;
    const primaryName = names?.find((n) => n.primary) ?? names?.[0];
    if (!primaryName?.first || !primaryName?.last) return null;

    const first = String(primaryName.first).toLowerCase().trim();
    const last = String(primaryName.last).toLowerCase().trim();

    const events = p.events as Array<{ type: string; sort_date?: string; date?: string }> | undefined;
    const birthEvent = events?.find((e) => e.type === 'birth');
    const rawDate = birthEvent?.sort_date || birthEvent?.date;
    const yearMatch = rawDate?.match(/(\d{4})/);
    const birthYear = yearMatch ? yearMatch[1] : null;

    return birthYear ? `${first}|${last}|${birthYear}` : `${first}|${last}`;
}

export async function gedcomRoutes(server: FastifyInstance) {
    const { graphEngine, txManager, dataDir } = (server as AppInstance).appServices;

    server.post('/api/import/gedcom', async (request, reply) => {
        let gedcomContent: string | undefined;
        let mode: string = 'replace';

        const contentType = request.headers['content-type'] || '';

        if (contentType.includes('multipart/form-data')) {
            const parts = request.parts();
            const chunks: Buffer[] = [];

            for await (const part of parts) {
                if (part.type === 'field' && part.fieldname === 'mode') {
                    mode = part.value as string;
                } else if (part.type === 'file' && part.fieldname === 'file') {
                    for await (const chunk of part.file) {
                        chunks.push(chunk);
                    }
                    gedcomContent = Buffer.concat(chunks).toString('utf8');
                }
            }
        } else {
            const body = request.body as { gedcom?: string; mode?: string };
            gedcomContent = body?.gedcom;
            mode = body?.mode ?? 'replace';
        }

        if (!gedcomContent) {
            return reply.status(400).send({
                error: 'GEDCOM content is required',
                code: 'MISSING_GEDCOM'
            });
        }

        if (mode !== 'replace' && mode !== 'additive') {
            return reply.status(400).send({
                error: 'Invalid mode. Must be "replace" or "additive".',
                code: 'INVALID_MODE'
            });
        }

        try {
            const reader = new GedcomReader();
            const result = await reader.parse(gedcomContent);

            if (result.people.length === 0) {
                return reply.status(400).send({
                    error: 'No valid people found in GEDCOM',
                    code: 'INVALID_GEDCOM'
                });
            }

            const peopleDir = path.join(dataDir, 'people');

            let peopleToWrite: Person[];
            let skipped = 0;

            if (mode === 'additive') {
                // Build dedup set from existing people
                const existingFiles = await fs.readdir(peopleDir).catch(() => [] as string[]);
                const dedupKeys = new Set<string>();

                for (const filename of existingFiles.filter(f => f.endsWith('.yaml'))) {
                    try {
                        const content = await fs.readFile(path.join(peopleDir, filename), 'utf8');
                        const existing = loadYaml(content);
                        const key = buildDedupKey(existing);
                        if (key) dedupKeys.add(key);
                    } catch { /* skip unparseable files */ }
                }

                const toWrite: Person[] = [];
                for (const person of result.people) {
                    const key = buildDedupKey(person);
                    if (key && dedupKeys.has(key)) {
                        skipped++;
                    } else {
                        toWrite.push(person);
                    }
                }

                peopleToWrite = toWrite;
            } else {
                // Replace mode: wipe existing YAML files, then rewrite
                const existingYamls = await fs.readdir(peopleDir).catch((err: NodeJS.ErrnoException) => {
                    if (err.code === 'ENOENT') return [] as string[];
                    throw err;
                });
                await fs.mkdir(peopleDir, { recursive: true });
                await Promise.all(
                    existingYamls
                        .filter(f => f.endsWith('.yaml'))
                        .map(f => fs.unlink(path.join(peopleDir, f)))
                );

                peopleToWrite = result.people;
            }

            // Single write/flush/hydrate block
            await fs.mkdir(peopleDir, { recursive: true });
            for (const person of peopleToWrite) {
                const relativePath = path.join('people', `${person.id}.yaml`);
                const primaryName = person.names?.[0];
                const label = primaryName ? `${primaryName.first} ${primaryName.last}` : person.id;
                await txManager.writeFile(relativePath, dumpYaml(person), label);
            }

            await txManager.flush();
            await graphEngine.hydrate();

            // Invalidate any stale batch geocoding results — the import changed
            // the set of people/events so occurrence counts and matches are unreliable.
            const batchResultsPath = path.join(dataDir, '_meta', '.batch-geocode-results.json');
            await fs.unlink(batchResultsPath).catch(() => {});

            const response: Record<string, unknown> = {
                imported: peopleToWrite.length,
                warnings: result.warnings,
            };
            if (mode === 'additive') response.skipped = skipped;
            return response;
        } catch (error: unknown) {
            console.error('[API] GEDCOM import error:', error);
            return reply.status(400).send({
                error: 'Failed to parse GEDCOM',
                code: 'INVALID_GEDCOM',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });
}
