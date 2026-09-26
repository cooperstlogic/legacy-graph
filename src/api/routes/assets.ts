import { FastifyInstance } from 'fastify';
import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { pipeline } from 'stream/promises';
import { AssetMetadataSchema } from '../../schemas/AssetSchema';
import { type Person, PersonSchema, type SlimPerson, toSlimPerson } from '../../schemas/PersonSchema';
import type { AppInstance } from '../types';
import { loadAssetIndex, saveAssetIndex, upsertAssetEntry, extractExifDate, reverseGeocodeExifGps } from '../../core/assetMetaUtils';
import type { Place } from '../../schemas/PlaceSchema';
import { isSafePathSegment } from '../../core/safePath';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.heif', '.tiff', '.tif', '.svg']);
const ALLOWED_EXTS = new Set([...IMAGE_EXTS, '.pdf', '.txt', '.md']);
const ALLOWED_MIME_PREFIXES = ['image/'];
const ALLOWED_MIMES = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/x-markdown']);

const isAllowedFile = (filename: string, mimetype: string) => {
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) return false;
    if (IMAGE_EXTS.has(ext)) return ALLOWED_MIME_PREFIXES.some(p => mimetype.startsWith(p));
    return ALLOWED_MIMES.has(mimetype);
};

const MIME_MAP: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.heic': 'image/heic', '.heif': 'image/heif', '.tiff': 'image/tiff',
    '.tif': 'image/tiff', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.md': 'text/markdown',
};

function getMimeType(filename: string): string {
    return MIME_MAP[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function isImage(filename: string): boolean {
    return IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}


export async function assetsRoutes(server: FastifyInstance) {
    const { graphEngine, txManager, dataDir } = (server as AppInstance).appServices;
    const assetsDir = path.join(dataDir, 'assets');
    const storiesDir = path.join(dataDir, 'stories');

    // ── GET /api/assets ──────────────────────────────────────────────────────

    server.get<{
        Querystring: { q?: string; type?: string; sort?: string; order?: string; personIds?: string }
    }>('/api/assets', async (request) => {
        const { q, type = 'all', sort = 'name', order = 'asc', personIds } = request.query;
        const searchQ = q?.trim().toLowerCase();
        const filterPersonIds = personIds ? personIds.split(',').filter(Boolean) : [];

        await fs.mkdir(assetsDir, { recursive: true });

        let filenames: string[];
        try {
            filenames = (await fs.readdir(assetsDir)).filter(f => !f.startsWith('.'));
        } catch {
            filenames = [];
        }

        // Build person + event reference maps
        const personRefs = new Map<string, string[]>();
        const eventRefs = new Map<string, Array<{ personId: string; eventId: string; eventType: string }>>();
        const personNames = new Map<string, string>(); // personId → displayName

        const graph = graphEngine.getGraph();
        graph.forEachNode((_nodeId, attrs) => {
            if (attrs.type !== 'person') return;
            const person = attrs.data as SlimPerson;
            const personId = person.id;

            // Build display name
            const n = person.names?.[0];
            const displayName = n
                ? `${n.first || ''} ${n.last || ''}`.trim()
                : personId;
            personNames.set(personId, displayName);

            if (Array.isArray(person.assets)) {
                for (const fn of person.assets) {
                    if (typeof fn !== 'string') continue;
                    if (!personRefs.has(fn)) personRefs.set(fn, []);
                    personRefs.get(fn)!.push(personId);
                }
            }
            if (Array.isArray(person.events)) {
                for (const event of person.events) {
                    if (!Array.isArray(event.assets)) continue;
                    for (const fn of event.assets) {
                        if (typeof fn !== 'string') continue;
                        if (!eventRefs.has(fn)) eventRefs.set(fn, []);
                        eventRefs.get(fn)!.push({ personId, eventId: event.id, eventType: event.type });
                    }
                }
            }
        });

        // Build story reference map (filename → [{ id, title }])
        const storyRefs = new Map<string, Array<{ id: string; title: string }>>();
        try {
            const storyFiles = (await fs.readdir(storiesDir)).filter(f => f.endsWith('.md'));
            for (const file of storyFiles) {
                try {
                    const raw = await fs.readFile(path.join(storiesDir, file), 'utf8');
                    const { data } = matter(raw);
                    const storyId = file.slice(0, -3);
                    const title = data.title ? String(data.title) : storyId;
                    if (!Array.isArray(data.assets)) continue;
                    for (const a of data.assets) {
                        if (typeof a !== 'string') continue;
                        if (!storyRefs.has(a)) storyRefs.set(a, []);
                        storyRefs.get(a)!.push({ id: storyId, title });
                    }
                } catch { /* skip malformed */ }
            }
        } catch { /* stories dir missing */ }

        const metaIndex = await loadAssetIndex(dataDir);

        let assets = await Promise.all(filenames.map(async (filename) => {
            let size = 0;
            try {
                const stat = await fs.stat(path.join(assetsDir, filename));
                size = stat.size;
            } catch { /* file disappeared */ }

            const people = personRefs.get(filename) ?? [];
            const stories = storyRefs.get(filename) ?? [];
            const events = eventRefs.get(filename) ?? [];

            const rawMeta = metaIndex[filename];
            const metadata = {
                name: rawMeta?.name as string | undefined,
                description: rawMeta?.description as string | undefined,
                date: rawMeta?.date as string | undefined,
                location: rawMeta?.location as Place | undefined,
                created_at: rawMeta?.created_at as string | undefined,
                modified_at: rawMeta?.modified_at as string | undefined,
            };

            return {
                filename,
                size,
                mimeType: getMimeType(filename),
                referencedBy: { people, stories, events },
                metadata,
                isOrphan: people.length === 0 && stories.length === 0 && events.length === 0,
            };
        }));

        // Apply type filter
        if (type === 'image') {
            assets = assets.filter(a => isImage(a.filename));
        } else if (type === 'document') {
            assets = assets.filter(a => !isImage(a.filename));
        }

        // Apply search filter (q)
        if (searchQ) {
            // Word-based matching: every query word must appear somewhere in the field.
            // This lets "gene webster" match "Gene E Webster" (middle initial between words).
            const words = searchQ.split(/\s+/).filter(Boolean);
            const allWordsIn = (text: string) => words.every(w => text.toLowerCase().includes(w));

            assets = assets.filter(a => {
                if (allWordsIn(a.filename)) return true;
                if (a.metadata.name != null && allWordsIn(a.metadata.name)) return true;
                if (a.metadata.description != null && allWordsIn(a.metadata.description)) return true;
                if (a.metadata.date != null && allWordsIn(a.metadata.date)) return true;
                if (a.metadata.location?.name != null && allWordsIn(a.metadata.location.name)) return true;
                // Match person names
                for (const pid of a.referencedBy.people) {
                    const name = personNames.get(pid) ?? '';
                    if (allWordsIn(name)) return true;
                }
                // Match story titles
                for (const s of a.referencedBy.stories) {
                    if (allWordsIn(s.title)) return true;
                }
                return false;
            });
        }

        // Apply personIds AND-filter
        if (filterPersonIds.length > 0) {
            assets = assets.filter(a =>
                filterPersonIds.every(pid => a.referencedBy.people.includes(pid))
            );
        }

        // Apply sort
        const sortOrder = order === 'desc' ? -1 : 1;
        assets.sort((a, b) => {
            if (sort === 'size') return (a.size - b.size) * sortOrder;
            if (sort === 'date') {
                const da = a.metadata.date ?? '';
                const db = b.metadata.date ?? '';
                return da < db ? -1 * sortOrder : da > db ? 1 * sortOrder : 0;
            }
            if (sort === 'created') {
                const ca = a.metadata.created_at;
                const cb = b.metadata.created_at;
                if (!ca && !cb) return 0;
                if (!ca) return 1;   // nulls sort last regardless of sortOrder
                if (!cb) return -1;
                return ca.localeCompare(cb) * sortOrder;
            }
            if (sort === 'modified') {
                const ma = a.metadata.modified_at;
                const mb = b.metadata.modified_at;
                if (!ma && !mb) return 0;
                if (!ma) return 1;   // nulls sort last regardless of sortOrder
                if (!mb) return -1;
                return ma.localeCompare(mb) * sortOrder;
            }
            // default: name (use display name if set, else filename)
            const na = a.metadata.name ?? a.filename;
            const nb = b.metadata.name ?? b.filename;
            return na.localeCompare(nb) * sortOrder;
        });

        return { assets, totalCount: assets.length };
    });

    // ── PUT /api/assets/:filename/meta ───────────────────────────────────────

    server.put<{
        Params: { filename: string };
        Body: { name?: string; description?: string; caption?: string; date?: string; date_taken?: string; location?: Place };
    }>('/api/assets/:filename/meta', async (request, reply) => {
        const { filename } = request.params;
        const { name, description, caption, date, date_taken, location } = request.body;

        if (!isSafePathSegment(filename)) {
            return reply.status(404).send({ error: 'Asset not found', code: 'ASSET_NOT_FOUND' });
        }
        try {
            await fs.access(path.join(assetsDir, filename));
        } catch {
            return reply.status(404).send({ error: 'Asset not found', code: 'ASSET_NOT_FOUND' });
        }

        const index = await loadAssetIndex(dataDir);
        const existing = index[filename] ?? {};

        // Backwards compat: caption → description, date_taken → date
        const resolvedDescription = description ?? caption;
        const resolvedDate = date ?? date_taken;

        const now = new Date().toISOString();
        const merged = {
            ...existing,
            ...(name !== undefined && { name }),
            ...(resolvedDescription !== undefined && { description: resolvedDescription }),
            ...(resolvedDate !== undefined && { date: resolvedDate }),
            ...(location !== undefined && { location }),
            // Preserve existing created_at; always bump modified_at
            created_at: existing.created_at ?? now,
            modified_at: now,
        };

        index[filename] = AssetMetadataSchema.parse(merged);
        await saveAssetIndex(dataDir, index, txManager);

        return {
            name: index[filename].name,
            description: index[filename].description,
            date: index[filename].date,
            location: index[filename].location,
            created_at: index[filename].created_at,
            modified_at: index[filename].modified_at,
        };
    });

    // ── DELETE /api/assets/:filename ─────────────────────────────────────────

    server.delete<{
        Params: { filename: string };
        Querystring: { force?: string };
    }>('/api/assets/:filename', async (request, reply) => {
        const { filename } = request.params;
        const force = request.query.force === 'true';
        if (!isSafePathSegment(filename)) {
            return reply.status(404).send({ error: 'Asset not found', code: 'ASSET_NOT_FOUND' });
        }
        const filePath = path.join(assetsDir, filename);

        try {
            await fs.access(filePath);
        } catch {
            return reply.status(404).send({ error: 'Asset not found', code: 'ASSET_NOT_FOUND' });
        }

        // Build refs for this file
        const people: string[] = [];
        const events: Array<{ personId: string; eventId: string; eventType: string }> = [];
        const graph = graphEngine.getGraph();
        graph.forEachNode((_nodeId, attrs) => {
            if (attrs.type !== 'person') return;
            const person = attrs.data as SlimPerson;
            const personId = person.id;
            if (Array.isArray(person.assets) && person.assets.includes(filename)) {
                people.push(personId);
            }
            if (Array.isArray(person.events)) {
                for (const event of person.events) {
                    if (Array.isArray(event.assets) && event.assets.includes(filename)) {
                        events.push({ personId, eventId: event.id as string, eventType: event.type as string });
                    }
                }
            }
        });

        const stories: string[] = [];
        try {
            const storyFiles = (await fs.readdir(storiesDir)).filter(f => f.endsWith('.md'));
            for (const file of storyFiles) {
                try {
                    const raw = await fs.readFile(path.join(storiesDir, file), 'utf8');
                    const { data } = matter(raw);
                    if (Array.isArray(data.assets) && data.assets.includes(filename)) {
                        stories.push(file.slice(0, -3));
                    }
                } catch { /* skip */ }
            }
        } catch { /* ignore */ }

        if (people.length > 0 || stories.length > 0 || events.length > 0) {
            if (!force) {
                return reply.status(409).send({
                    error: 'Asset is still referenced and cannot be deleted',
                    code: 'ASSET_REFERENCED',
                    referencedBy: { people, stories, events },
                });
            }

            // force=true: strip all references first, then fall through to deletion
            const affectedPersonIds = new Set([...people, ...events.map(e => e.personId)]);

            for (const personId of affectedPersonIds) {
                if (!graph.hasNode(personId)) continue;

                const slimData = graph.getNodeAttributes(personId).data as SlimPerson;
                const heavyFields = await graphEngine.loadHeavyFields(personId);
                const fullPerson: Person = {
                    ...slimData,
                    scrapbook_md: heavyFields?.scrapbook_md ?? '',
                    _gedcom: heavyFields?._gedcom,
                };

                fullPerson.assets = fullPerson.assets.filter(a => a !== filename);
                fullPerson.events = fullPerson.events.map(e => ({
                    ...e,
                    assets: e.assets.filter(a => a !== filename),
                }));
                fullPerson.last_modified = new Date().toISOString();

                const primaryName = fullPerson.names?.[0];
                const label = primaryName ? `${primaryName.first} ${primaryName.last}` : personId;
                await txManager.writeFile(path.join('people', `${personId}.yaml`), yaml.dump(fullPerson), label);

                const newSlim = toSlimPerson(fullPerson);
                graph.setNodeAttribute(personId, 'data', newSlim);
                graphEngine.applyWriteSideEffects(personId, slimData, newSlim, fullPerson.scrapbook_md || '');
            }

            for (const storyId of stories) {
                const storyFilePath = path.join(storiesDir, `${storyId}.md`);
                try {
                    const raw = await fs.readFile(storyFilePath, 'utf8');
                    const parsed = matter(raw);
                    if (Array.isArray(parsed.data.assets)) {
                        parsed.data.assets = (parsed.data.assets as string[]).filter(a => a !== filename);
                        await txManager.writeFile(path.join('stories', `${storyId}.md`), matter.stringify(parsed.content, parsed.data), `story ${storyId}`);
                    }
                } catch { /* skip if story missing */ }
            }
        }

        await fs.unlink(filePath);
        await txManager.removeFile(path.join('assets', filename), `asset ${filename}`);

        const index = await loadAssetIndex(dataDir);
        if (Object.prototype.hasOwnProperty.call(index, filename)) {
            delete index[filename];
            await saveAssetIndex(dataDir, index, txManager);
        }

        return reply.status(204).send();
    });

    // ── PUT /api/people/:id/events/:eventId/media ────────────────────────────

    server.put<{ Params: { id: string; eventId: string } }>(
        '/api/people/:id/events/:eventId/media',
        async (request, reply) => {
            const { id, eventId } = request.params;
            const graph = graphEngine.getGraph();

            if (!graph.hasNode(id)) {
                return reply.status(404).send({ error: 'Person not found', code: 'PERSON_NOT_FOUND' });
            }

            const slimData = graph.getNodeAttributes(id).data as SlimPerson;
            const events = slimData.events ?? [];
            const eventIdx = events.findIndex(e => e.id === eventId);
            if (eventIdx === -1) {
                return reply.status(404).send({ error: 'Event not found', code: 'EVENT_NOT_FOUND' });
            }

            let fileData: Awaited<ReturnType<typeof request.file>>;
            try {
                fileData = await request.file();
            } catch (err: unknown) {
                if (err && typeof err === 'object' && 'code' in err && err.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
                    return reply.status(400).send({ error: 'Request must be multipart/form-data', code: 'VALIDATION_ERROR' });
                }
                throw err;
            }
            if (!fileData) {
                return reply.status(400).send({ error: 'No file uploaded', code: 'VALIDATION_ERROR' });
            }

            if (!isAllowedFile(fileData.filename, fileData.mimetype)) {
                fileData.file.resume();
                return reply.status(415).send({ error: 'File type not allowed.', code: 'UNSUPPORTED_FILE_TYPE' });
            }

            await fs.mkdir(assetsDir, { recursive: true });

            const ext = path.extname(fileData.filename).toLowerCase();
            const rawBase = path.basename(fileData.filename, path.extname(fileData.filename))
                .replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
            const baseName = rawBase || 'upload';

            let uniqueFilename = `${baseName}${ext}`;
            let counter = 1;
            while (true) {
                try {
                    await fs.access(path.join(assetsDir, uniqueFilename));
                    uniqueFilename = `${baseName}-${counter}${ext}`;
                    counter++;
                } catch { break; }
            }

            const uniqueFilepath = path.join(assetsDir, uniqueFilename);
            await pipeline(fileData.file, nodeFs.createWriteStream(uniqueFilepath));
            await txManager.trackFile(path.join('assets', uniqueFilename), `asset ${uniqueFilename}`);

            // Seed assets.yaml with created_at + EXIF capture date + GPS location (best-effort, never blocks upload)
            const now = new Date().toISOString();
            const { geocodingService } = (server as AppInstance).appServices;
            const [exifDate, exifGps] = await Promise.all([
                extractExifDate(uniqueFilepath),
                reverseGeocodeExifGps(uniqueFilepath, geocodingService),
            ]);
            await upsertAssetEntry(dataDir, uniqueFilename, {
                created_at: now,
                ...(exifDate && { date: exifDate }),
                ...(exifGps && { location: exifGps }),
            }, txManager);

            const heavyFields = await graphEngine.loadHeavyFields(id);
            const fullPerson: Person = {
                ...slimData,
                scrapbook_md: heavyFields?.scrapbook_md ?? '',
                _gedcom: heavyFields?._gedcom,
            };

            fullPerson.events = fullPerson.events.map((e, i) =>
                i === eventIdx
                    ? { ...e, assets: [...e.assets, uniqueFilename] }
                    : e
            );
            // Also link the uploaded file to the person's top-level assets[] (idempotent)
            if (!fullPerson.assets.includes(uniqueFilename)) {
                fullPerson.assets = [...fullPerson.assets, uniqueFilename];
            }
            fullPerson.last_modified = new Date().toISOString();

            PersonSchema.parse(fullPerson);

            const primaryName = fullPerson.names?.[0];
            const label = primaryName ? `${primaryName.first} ${primaryName.last}` : id;
            await txManager.writeFile(path.join('people', `${id}.yaml`), yaml.dump(fullPerson), label);

            const newSlim = toSlimPerson(fullPerson);
            graph.setNodeAttribute(id, 'data', newSlim);
            graphEngine.applyWriteSideEffects(id, slimData, newSlim, fullPerson.scrapbook_md || '');

            return { filename: uniqueFilename, events: fullPerson.events };
        }
    );

    // ── POST /api/assets/upload ───────────────────────────────────────────────

    server.post('/api/assets/upload', async (request, reply) => {
        await fs.mkdir(assetsDir, { recursive: true });

        const uploaded: Array<{ filename: string; originalName: string }> = [];
        const rejected: Array<{ originalName: string; reason: string }> = [];

        try {
            const parts = request.parts();
            for await (const part of parts) {
                if (part.type !== 'file') continue;

                const originalName: string = part.filename || 'upload';

                if (!isAllowedFile(originalName, part.mimetype)) {
                    part.file.resume();
                    rejected.push({ originalName, reason: 'File type not allowed' });
                    continue;
                }

                const ext = path.extname(originalName).toLowerCase();
                const rawBase = path.basename(originalName, path.extname(originalName))
                    .replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
                const baseName = rawBase || 'upload';

                let uniqueFilename = `${baseName}${ext}`;
                let counter = 1;
                while (true) {
                    try {
                        await fs.access(path.join(assetsDir, uniqueFilename));
                        uniqueFilename = `${baseName}-${counter}${ext}`;
                        counter++;
                    } catch { break; }
                }

                const destPath = path.join(assetsDir, uniqueFilename);
                await pipeline(part.file, nodeFs.createWriteStream(destPath));
                await txManager.trackFile(path.join('assets', uniqueFilename), `asset ${uniqueFilename}`);

                const now = new Date().toISOString();
                const [exifDate, exifGps] = await Promise.all([
                    extractExifDate(destPath),
                    reverseGeocodeExifGps(destPath, (server as AppInstance).appServices.geocodingService),
                ]);
                await upsertAssetEntry(dataDir, uniqueFilename, {
                    created_at: now,
                    ...(exifDate && { date: exifDate }),
                    ...(exifGps && { location: exifGps }),
                }, txManager);

                uploaded.push({ filename: uniqueFilename, originalName });
            }
        } catch (err: unknown) {
            if (err && typeof err === 'object' && 'code' in err && err.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
                return reply.status(400).send({ error: 'No files provided', code: 'VALIDATION_ERROR' });
            }
            throw err;
        }

        if (uploaded.length === 0 && rejected.length === 0) {
            return reply.status(400).send({ error: 'No files provided', code: 'VALIDATION_ERROR' });
        }

        return { uploaded, rejected };
    });

    // ── POST /api/people/:id/assets/link ─────────────────────────────────────

    server.post<{
        Params: { id: string };
        Body: { filename: string };
    }>('/api/people/:id/assets/link', async (request, reply) => {
        const { id } = request.params;
        const { filename } = request.body ?? {};
        const graph = graphEngine.getGraph();

        if (!graph.hasNode(id)) {
            return reply.status(404).send({ error: 'Person not found', code: 'PERSON_NOT_FOUND' });
        }

        if (!filename || typeof filename !== 'string') {
            return reply.status(400).send({ error: 'filename is required', code: 'VALIDATION_ERROR' });
        }
        if (!isSafePathSegment(filename)) {
            return reply.status(400).send({ error: 'Invalid filename', code: 'VALIDATION_ERROR' });
        }

        try {
            await fs.access(path.join(assetsDir, filename));
        } catch {
            return reply.status(400).send({ error: 'Asset file not found on disk', code: 'ASSET_NOT_FOUND' });
        }

        const slimData = graph.getNodeAttributes(id).data as SlimPerson;
        const heavyFields = await graphEngine.loadHeavyFields(id);
        const fullPerson: Person = {
            ...slimData,
            scrapbook_md: heavyFields?.scrapbook_md ?? '',
            _gedcom: heavyFields?._gedcom,
        };

        // Idempotent
        if (fullPerson.assets.includes(filename)) {
            return { assets: fullPerson.assets };
        }

        fullPerson.assets = [...fullPerson.assets, filename];
        fullPerson.last_modified = new Date().toISOString();

        PersonSchema.parse(fullPerson);

        const primaryName = fullPerson.names?.[0];
        const label = primaryName ? `${primaryName.first} ${primaryName.last}` : id;
        await txManager.writeFile(path.join('people', `${id}.yaml`), yaml.dump(fullPerson), label);

        const newSlim = toSlimPerson(fullPerson);
        graph.setNodeAttribute(id, 'data', newSlim);
        graphEngine.applyWriteSideEffects(id, slimData, newSlim, fullPerson.scrapbook_md || '');

        return { assets: fullPerson.assets };
    });
}
