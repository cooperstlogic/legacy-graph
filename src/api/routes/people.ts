import { FastifyInstance } from 'fastify';
import { generatePersonId } from '../../utils/idGenerator';
import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';
import matter from 'gray-matter';
import { pipeline } from 'stream/promises';
import { Person, PersonSchema, SlimPerson, toSlimPerson } from '../../schemas/PersonSchema';
import { sliceTimeline, type TimelineItem, type PaginatedTimeline } from '../../core/TimelineSlicer';
import { invalidateComputed } from '../../core/GraphLogic';
import type { AppInstance } from '../types';
import { isSafePathSegment } from '../../core/safePath';
import { loadAssetIndex, saveAssetIndex, upsertAssetEntry, extractExifDate, reverseGeocodeExifGps } from '../../core/assetMetaUtils';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.heif', '.tiff', '.tif', '.svg']);
const ALLOWED_EXTS = new Set([...IMAGE_EXTS, '.pdf', '.txt', '.md']);
const ALLOWED_MIME_PREFIXES = ['image/'];
const ALLOWED_MIMES = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/x-markdown']);
const isImageFile = (filename: string) => IMAGE_EXTS.has(path.extname(filename).toLowerCase());
const isAllowedFile = (filename: string, mimetype: string) => {
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) return false;
    if (IMAGE_EXTS.has(ext)) return ALLOWED_MIME_PREFIXES.some(p => mimetype.startsWith(p));
    return ALLOWED_MIMES.has(mimetype);
};

export async function peopleRoutes(server: FastifyInstance) {
    const { graphEngine, txManager, dataDir } = (server as AppInstance).appServices;

    server.get<{
        Querystring: { limit?: string; offset?: string; sort?: string; order?: string }
    }>('/api/people', async (request, reply) => {
        const { limit: limitStr, offset: offsetStr, sort, order } = request.query;

        const limit = limitStr ? parseInt(limitStr, 10) : 50;
        const offset = offsetStr ? parseInt(offsetStr, 10) : 0;

        if (isNaN(limit) || limit < 0 || limit > 200) {
            return reply.status(400).send({
                error: 'limit must be between 0 and 200',
                code: 'VALIDATION_ERROR'
            });
        }
        if (isNaN(offset) || offset < 0) {
            return reply.status(400).send({
                error: 'offset must be >= 0',
                code: 'VALIDATION_ERROR'
            });
        }

        const graph = graphEngine.getGraph();

        interface PersonListItem {
            id: string;
            names: SlimPerson['names'];
            sex: string;
            birthDate: string | undefined;
            deathDate: string | undefined;
            tags: string[] | undefined;
            assetCount: number;
            primaryAsset: string | undefined;
            last_modified: string | undefined;
        }

        const people: PersonListItem[] = [];

        graph.forEachNode((_nodeId, attributes) => {
            if (attributes.type === 'person') {
                const p = attributes.data as SlimPerson;
                people.push({
                    id: p.id,
                    names: p.names,
                    sex: p.sex,
                    birthDate: p.events?.find(e => e.type === 'birth')?.date,
                    deathDate: p.events?.find(e => e.type === 'death')?.date,
                    tags: p.tags,
                    assetCount: p.assets?.length || 0,
                    primaryAsset: p.assets?.find(isImageFile),
                    last_modified: p.last_modified
                });
            }
        });

        const VALID_SORT_FIELDS = ['last_modified', 'birthDate', 'deathDate', 'assetCount'] as const;
        type SortField = typeof VALID_SORT_FIELDS[number];
        const validSortSet = new Set<string>(VALID_SORT_FIELDS);
        const sortBy: SortField = (sort && validSortSet.has(sort)) ? sort as SortField : 'last_modified';
        const sortOrder = (order === 'asc' || order === 'desc') ? (order === 'asc' ? 1 : -1) : -1;

        people.sort((a, b) => {
            const valA = a[sortBy] ?? '';
            const valB = b[sortBy] ?? '';
            if (valA < valB) return -1 * sortOrder;
            if (valA > valB) return 1 * sortOrder;
            return 0;
        });

        const totalCount = people.length;
        const paginatedPeople = people.slice(offset, offset + limit);

        return {
            people: paginatedPeople,
            totalCount
        };
    });

    server.get<{
        Params: { id: string },
        Querystring: { timeline_limit?: string; timeline_offset?: string }
    }>('/api/people/:id', async (request, reply) => {
        const { id } = request.params;
        const { timeline_limit: limitStr, timeline_offset: offsetStr } = request.query;
        const graph = graphEngine.getGraph();

        if (!graph.hasNode(id)) {
            return reply.status(404).send({
                error: 'Person not found',
                code: 'PERSON_NOT_FOUND'
            });
        }

        const nodeData = graph.getNodeAttributes(id);
        const slimPerson = nodeData.data;

        const computed = nodeData._computed || {
            currentSpouse: null,
            siblings: [],
            children: [],
            allSpouses: []
        };

        const heavyFields = await graphEngine.loadHeavyFields(id);

        let timeline: TimelineItem[] | PaginatedTimeline;
        if (limitStr !== undefined || offsetStr !== undefined) {
            const limit = limitStr ? parseInt(limitStr, 10) : 50;
            const offset = offsetStr ? parseInt(offsetStr, 10) : 0;

            if (isNaN(limit) || limit < 0 || limit > 200) {
                return reply.status(400).send({
                    error: 'timeline_limit must be between 0 and 200',
                    code: 'VALIDATION_ERROR'
                });
            }
            if (isNaN(offset) || offset < 0) {
                return reply.status(400).send({
                    error: 'timeline_offset must be >= 0',
                    code: 'VALIDATION_ERROR'
                });
            }

            timeline = sliceTimeline(graph, id, { limit, offset });
        } else {
            timeline = sliceTimeline(graph, id);
        }

        return {
            ...slimPerson,
            scrapbook_md: heavyFields?.scrapbook_md ?? '',
            _gedcom: heavyFields?._gedcom,
            _computed: computed,
            timeline
        };
    });

    server.post<{
        Body: Partial<Person>
    }>('/api/people', async (request, reply) => {
        const body = request.body;

        try {
            if (!body.names || body.names.length === 0) {
                return reply.status(400).send({
                    error: 'Names array is required',
                    code: 'VALIDATION_ERROR'
                });
            }

            if (!body.sex || !['M', 'F', 'I', 'U'].includes(body.sex)) {
                return reply.status(400).send({
                    error: 'Invalid sex value',
                    code: 'VALIDATION_ERROR'
                });
            }

            const newPerson: Person = PersonSchema.parse({
                version: '5.0',
                id: generatePersonId({ names: body.names, events: body.events }),
                created: new Date().toISOString(),
                last_modified: new Date().toISOString(),
                names: body.names,
                sex: body.sex,
                tags: body.tags || [],
                relationships: body.relationships || { parents: [] },
                events: body.events || [],
                assets: body.assets || [],
                scrapbook_md: body.scrapbook_md || '',
                _gedcom: body._gedcom,
            });

            const relativePath = path.join('people', `${newPerson.id}.yaml`);
            const primaryName = newPerson.names[0];
            const label = `${primaryName.first} ${primaryName.last}`;
            await txManager.writeFile(relativePath, yaml.dump(newPerson), label);

            const graph = graphEngine.getGraph();
            const slim = toSlimPerson(newPerson);
            graph.addNode(newPerson.id, { type: 'person', data: slim });

            graphEngine.applyWriteSideEffects(newPerson.id, null, slim, newPerson.scrapbook_md || '');

            return reply.status(201).send(newPerson);
        } catch (error: unknown) {
            console.error('[API] Error creating person:', error);
            return reply.status(400).send({
                error: 'Invalid person data',
                code: 'VALIDATION_ERROR',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    server.put<{
        Params: { id: string },
        Body: Partial<Person>
    }>('/api/people/:id', async (request, reply) => {
        const { id } = request.params;
        const patch = request.body;
        const graph = graphEngine.getGraph();

        if (!graph.hasNode(id)) {
            return reply.status(404).send({
                error: 'Person not found',
                code: 'PERSON_NOT_FOUND'
            });
        }

        try {
            const oldSlim = graph.getNodeAttributes(id).data as SlimPerson;

            // Load heavy fields so we can reconstruct the full person before merging
            const heavyFields = await graphEngine.loadHeavyFields(id);
            const currentPerson: Person = {
                ...oldSlim,
                scrapbook_md: heavyFields?.scrapbook_md ?? '',
                _gedcom: heavyFields?._gedcom,
            };

            // Merge the incoming patch with the existing full person, then validate.
            // Strip immutable fields from patch to prevent id/filename mismatches.
            const { id: _pid, created: _pc, version: _pv, ...safePatch } = patch as Record<string, unknown>;
            const merged: Person = {
                ...currentPerson,
                ...safePatch,
                id,
                created: currentPerson.created,
                version: currentPerson.version,
                last_modified: new Date().toISOString(),
            };

            PersonSchema.parse(merged);

            const relativePath = path.join('people', `${id}.yaml`);
            const primaryName = merged.names?.[0];
            const label = primaryName ? `${primaryName.first} ${primaryName.last}` : id;
            await txManager.writeFile(relativePath, yaml.dump(merged), label);

            const newSlim = toSlimPerson(merged);
            graph.setNodeAttribute(id, 'data', newSlim);

            graphEngine.applyWriteSideEffects(id, oldSlim, newSlim, merged.scrapbook_md || '');

            return merged;
        } catch (error: unknown) {
            console.error('[API] Error updating person:', error);
            return reply.status(400).send({
                error: 'Invalid person data',
                code: 'VALIDATION_ERROR',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // DELETE /api/people/:id — remove a person and their assets
    server.delete<{
        Params: { id: string }
    }>('/api/people/:id', async (request, reply) => {
        const { id } = request.params;
        const graph = graphEngine.getGraph();

        // IDs come from people/*.yaml, which can be hand-edited; the id is joined
        // onto people/ and assets/ below, so it must be a single path segment.
        if (!isSafePathSegment(id) || !graph.hasNode(id)) {
            return reply.status(404).send({
                error: 'Person not found',
                code: 'PERSON_NOT_FOUND',
            });
        }

        // Remove the YAML file
        const relativePath = path.join('people', `${id}.yaml`);
        const fullPath = path.join(dataDir, relativePath);
        try {
            await fs.unlink(fullPath);
        } catch {
            // File may already be gone
        }

        // Remove person's assets directory if it exists
        const personAssetsDir = path.join(dataDir, 'assets', id);
        try {
            await fs.rm(personAssetsDir, { recursive: true, force: true });
        } catch {
            // May not exist
        }

        // Remove from graph (drops edges + search index)
        if (graph.hasNode(id)) {
            // Invalidate computed relationships for connected nodes before removal
            const neighbors = graph.neighbors(id);
            graph.dropNode(id);
            graphEngine.searchService.removePerson(id);
            for (const neighbor of neighbors) {
                if (graph.hasNode(neighbor)) {
                    invalidateComputed(graph, neighbor);
                }
            }
            graphEngine.emit('graph-updated');
        }

        // Stage the deletion in git
        await txManager.removeFile(relativePath, id);

        return { ok: true };
    });

    server.put<{
        Params: { id: string }
    }>('/api/people/:id/media', async (request, reply) => {
        const { id } = request.params;
        const graph = graphEngine.getGraph();

        if (!graph.hasNode(id)) {
            return reply.status(404).send({
                error: 'Person not found',
                code: 'PERSON_NOT_FOUND'
            });
        }

        try {
            const data = await request.file();

            if (!data) {
                return reply.status(400).send({
                    error: 'No file provided',
                    code: 'MISSING_FILE'
                });
            }

            if (!isAllowedFile(data.filename, data.mimetype)) {
                data.file.resume(); // drain stream to avoid hanging connection
                return reply.status(415).send({
                    error: 'File type not allowed. Supported types: images, PDF, TXT, MD.',
                    code: 'UNSUPPORTED_FILE_TYPE'
                });
            }

            const ext = path.extname(data.filename).toLowerCase();
            const rawBase = path.basename(data.filename, path.extname(data.filename)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
            const baseName = rawBase || 'upload';

            const assetsDir = path.join(dataDir, 'assets');
            await fs.mkdir(assetsDir, { recursive: true });

            // Find a unique filename — keep original, add -1, -2, … only on conflict
            let uniqueFilename = `${baseName}${ext}`;
            let counter = 1;
            while (true) {
                try {
                    await fs.access(path.join(assetsDir, uniqueFilename));
                    // File exists — try next suffix
                    uniqueFilename = `${baseName}-${counter}${ext}`;
                    counter++;
                } catch {
                    break; // File doesn't exist — name is available
                }
            }

            const filepath = path.join(assetsDir, uniqueFilename);
            await pipeline(data.file, nodeFs.createWriteStream(filepath));

            await txManager.trackFile(path.join('assets', uniqueFilename), `asset ${uniqueFilename}`);

            // Seed assets.yaml with created_at + EXIF capture date + GPS location (best-effort, never blocks upload)
            const now = new Date().toISOString();
            const { geocodingService } = (server as AppInstance).appServices;
            const [exifDate, exifGps] = await Promise.all([
                extractExifDate(filepath),
                reverseGeocodeExifGps(filepath, geocodingService),
            ]);
            await upsertAssetEntry(dataDir, uniqueFilename, {
                created_at: now,
                ...(exifDate && { date: exifDate }),
                ...(exifGps && { location: exifGps }),
            }, txManager);

            const heavyFields = await graphEngine.loadHeavyFields(id);
            const slimData = graph.getNodeAttributes(id).data;

            const fullPerson: Person = {
                ...slimData,
                scrapbook_md: heavyFields?.scrapbook_md ?? '',
                _gedcom: heavyFields?._gedcom,
            } as Person;

            if (!fullPerson.assets.includes(uniqueFilename)) {
                fullPerson.assets.push(uniqueFilename);
            }

            fullPerson.last_modified = new Date().toISOString();

            const personRelPath = path.join('people', `${id}.yaml`);
            const primaryName = fullPerson.names?.[0];
            const label = primaryName ? `${primaryName.first} ${primaryName.last}` : id;
            await txManager.writeFile(personRelPath, yaml.dump(fullPerson), label);

            graph.setNodeAttribute(id, 'data', toSlimPerson(fullPerson));
            invalidateComputed(graphEngine.getGraph(), id);

            return {
                filename: uniqueFilename,
                assets: fullPerson.assets
            };
        } catch (error: unknown) {
            if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
                return reply.status(400).send({
                    error: 'No file provided',
                    code: 'MISSING_FILE'
                });
            }

            console.error('[API] Error uploading media:', error);
            return reply.status(500).send({
                error: 'Failed to upload media',
                code: 'UPLOAD_ERROR',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    server.delete<{
        Params: { id: string; filename: string };
        Querystring: { permanent?: string };
    }>('/api/people/:id/media/:filename', async (request, reply) => {
        const { id, filename } = request.params;
        const permanent = request.query.permanent === 'true';
        const graph = graphEngine.getGraph();

        if (!graph.hasNode(id)) {
            return reply.status(404).send({
                error: 'Person not found',
                code: 'PERSON_NOT_FOUND'
            });
        }

        const heavyFields = await graphEngine.loadHeavyFields(id);
        const slimData = graph.getNodeAttributes(id).data as SlimPerson;
        const fullPerson: Person = {
            ...slimData,
            scrapbook_md: heavyFields?.scrapbook_md ?? '',
            _gedcom: heavyFields?._gedcom,
        } as Person;

        // assets[] is client-supplied, so membership alone doesn't make the name safe to unlink
        if (!isSafePathSegment(filename) || !fullPerson.assets.includes(filename)) {
            return reply.status(404).send({
                error: 'Asset not found',
                code: 'ASSET_NOT_FOUND'
            });
        }

        // Unlink from person.assets[] and persist
        const oldSlim = graph.getNodeAttributes(id).data as SlimPerson;
        fullPerson.assets = fullPerson.assets.filter(a => a !== filename);
        fullPerson.last_modified = new Date().toISOString();

        const relativePath = path.join('people', `${id}.yaml`);
        const primaryName = fullPerson.names?.[0];
        const label = primaryName ? `${primaryName.first} ${primaryName.last}` : id;
        await txManager.writeFile(relativePath, yaml.dump(fullPerson), label);

        const newSlim = toSlimPerson(fullPerson);
        graph.setNodeAttribute(id, 'data', newSlim);
        graphEngine.applyWriteSideEffects(id, oldSlim, newSlim, fullPerson.scrapbook_md || '');

        if (!permanent) {
            return reply.status(204).send();
        }

        // ?permanent=true: also delete the file from disk if no other references remain.
        // Check other persons (excluding this one, already unlinked above)
        const otherPersonRefs: string[] = [];
        const otherEventRefs: string[] = [];
        graph.forEachNode((_nodeId, attrs) => {
            if (attrs.type !== 'person') return;
            const person = attrs.data as SlimPerson;
            if (person.id === id) return; // already unlinked
            if (person.assets.includes(filename)) {
                otherPersonRefs.push(person.id);
            }
            for (const event of person.events) {
                if (event.assets.includes(filename)) {
                    otherEventRefs.push(person.id);
                }
            }
        });

        // Check stories
        const storiesDir = path.join(dataDir, 'stories');
        const storyRefs: string[] = [];
        try {
            const storyFiles = (await fs.readdir(storiesDir)).filter(f => f.endsWith('.md'));
            for (const file of storyFiles) {
                try {
                    const raw = await fs.readFile(path.join(storiesDir, file), 'utf8');
                    const { data } = matter(raw);
                    if (Array.isArray(data.assets) && data.assets.includes(filename)) {
                        storyRefs.push(file.slice(0, -3));
                    }
                } catch { /* skip */ }
            }
        } catch { /* stories dir missing */ }

        const hasOtherRefs = otherPersonRefs.length > 0 || otherEventRefs.length > 0 || storyRefs.length > 0;

        if (hasOtherRefs) {
            // Still referenced elsewhere — unlink succeeded but file not deleted
            return reply.status(200).send({
                fileDeleted: false,
                referencedBy: { people: otherPersonRefs, events: otherEventRefs, stories: storyRefs },
            });
        }

        // No other references — delete the file and clean up assets.yaml
        const filePath = path.join(dataDir, 'assets', filename);
        try {
            await fs.unlink(filePath);
            await txManager.removeFile(path.join('assets', filename), `asset ${filename}`);
        } catch {
            return reply.status(200).send({ fileDeleted: false });
        }

        const index = await loadAssetIndex(dataDir);
        if (Object.prototype.hasOwnProperty.call(index, filename)) {
            delete index[filename];
            await saveAssetIndex(dataDir, index, txManager);
        }

        return reply.status(200).send({ fileDeleted: true });
    });

    // ── DELETE /api/people/:id/assets/link/:filename ─────────────────────────
    // Explicit unlink: removes from person.assets[] AND person.events[].assets[].
    // Does NOT delete the file from disk. Returns 204.

    server.delete<{
        Params: { id: string; filename: string }
    }>('/api/people/:id/assets/link/:filename', async (request, reply) => {
        const { id, filename } = request.params;
        const graph = graphEngine.getGraph();

        if (!graph.hasNode(id)) {
            return reply.status(404).send({ error: 'Person not found', code: 'PERSON_NOT_FOUND' });
        }

        const heavyFields = await graphEngine.loadHeavyFields(id);
        const slimData = graph.getNodeAttributes(id).data as SlimPerson;
        const fullPerson: Person = {
            ...slimData,
            scrapbook_md: heavyFields?.scrapbook_md ?? '',
            _gedcom: heavyFields?._gedcom,
        } as Person;

        const inPersonAssets = fullPerson.assets.includes(filename);
        const inEventAssets = fullPerson.events.some(
            e => e.assets.includes(filename)
        );

        if (!inPersonAssets && !inEventAssets) {
            return reply.status(404).send({ error: 'Asset not linked to this person', code: 'ASSET_NOT_FOUND' });
        }

        const oldSlim = graph.getNodeAttributes(id).data as SlimPerson;
        fullPerson.assets = fullPerson.assets.filter(a => a !== filename);
        fullPerson.events = fullPerson.events.map(e => ({
            ...e,
            assets: e.assets.filter(a => a !== filename),
        }));
        fullPerson.last_modified = new Date().toISOString();

        const relativePath = path.join('people', `${id}.yaml`);
        const primaryName = fullPerson.names?.[0];
        const label = primaryName ? `${primaryName.first} ${primaryName.last}` : id;
        await txManager.writeFile(relativePath, yaml.dump(fullPerson), label);

        const newSlim = toSlimPerson(fullPerson);
        graph.setNodeAttribute(id, 'data', newSlim);
        graphEngine.applyWriteSideEffects(id, oldSlim, newSlim, fullPerson.scrapbook_md || '');

        return reply.status(204).send();
    });
}
