import { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import * as fs from 'fs/promises';
import * as nodeFs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { pipeline } from 'stream/promises';
import { remark } from 'remark';
import { visit } from 'unist-util-visit';
import { StorySchema, StoryFeedItem, FullStory } from '../../schemas/StorySchema';
import { formatPlaceDisplay, type Place } from '../../schemas/PlaceSchema';
import type { SlimPerson } from '../../schemas/PersonSchema';
import type { AppInstance } from '../types';
import { isSafePathSegment } from '../../core/safePath';

/** Strip `.md` from a filename to get the API-facing story id. */
function filenameToId(filename: string): string {
    return filename.endsWith('.md') ? filename.slice(0, -3) : filename;
}

/** Parse @N_xxx and [[N_xxx]] mentions from Markdown body text. */
function extractMentions(content: string): string[] {
    const mentions = new Set<string>();
    remark().use(() => (tree) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unist-util-visit node type is untyped
        visit(tree, 'text', (node: any) => {
            const regex = /(@N_[a-zA-Z0-9_-]+)|(\[\[(N_[a-zA-Z0-9_-]+)\]\])/g;
            let match;
            while ((match = regex.exec(node.value)) !== null) {
                const id = match[1] || match[3];
                if (id) mentions.add(id.replace('@', ''));
            }
        });
    }).processSync(content);
    return Array.from(mentions);
}

/** Build a StoryFeedItem from raw story data. */
function toFeedItem(
    id: string,
    metadata: Record<string, unknown>,
    content: string,
    mentions: string[],
    resolvePersonName?: (personId: string) => string,
): StoryFeedItem {
    const people = Array.from(new Set([...((metadata.people as string[] | undefined) ?? []), ...mentions]));
    // Sanitize Milkdown serialization artifacts before processing
    // (Milkdown escapes _ as \_ and encodes spaces as &#x20; in raw markdown)
    const sanitized = content.replace(/&#x20;/g, ' ').replace(/\\_/g, '_');
    // Replace @N_xxx / [[N_xxx]] with resolved person names (or strip if resolver unavailable)
    const withNames = sanitized
        .replace(/@N_[a-zA-Z0-9_-]+/g, (match) => {
            const personId = match.slice(1);
            return resolvePersonName ? resolvePersonName(personId) : '';
        })
        .replace(/\[\[N_[a-zA-Z0-9_-]+\]\]/g, (match) => {
            const personId = match.slice(2, -2);
            return resolvePersonName ? resolvePersonName(personId) : '';
        });
    // Strip markdown formatting to produce plain text
    const bodyText = withNames
        .replace(/<[^>]+>/g, '')                       // HTML tags (e.g. <br />, <p>)
        .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, '') // Remaining HTML entities
        .replace(/#{1,6}\s+/g, '')                    // Headings
        .replace(/\*\*([^*]+)\*\*/g, '$1')            // Bold **text**
        .replace(/__([^_]+)__/g, '$1')                // Bold __text__
        .replace(/\*([^*]+)\*/g, '$1')                // Italic *text*
        .replace(/_([^_]+)_/g, '$1')                  // Italic _text_
        .replace(/~~([^~]+)~~/g, '$1')                // Strikethrough
        .replace(/`{1,3}[^`]*`{1,3}/g, '')            // Inline code + code fences
        .replace(/!\[.*?\]\(.*?\)/g, '')               // Images
        .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')        // Links → show text only
        .replace(/^\s*[-*+]\s/gm, '')                  // Unordered list bullets
        .replace(/^\s*\d+\.\s/gm, '')                  // Ordered list numbers
        .replace(/^\s*>\s?/gm, '')                     // Blockquotes
        .replace(/[-_*]{3,}/g, '')                     // Horizontal rules
        .replace(/\n{2,}/g, ' · ')                    // Paragraph breaks → visual separator
        .replace(/\n/g, ' ')                           // Single newlines → space
        .replace(/\s+/g, ' ')
        .trim();
    const excerpt = bodyText.length > 280 ? bodyText.slice(0, 280) : bodyText;
    return {
        id,
        title: metadata.title as string,
        date: metadata.date as string | undefined,
        place: metadata.place as Place | undefined,
        people,
        excerpt,
        firstAsset: (metadata.assets as string[] | undefined)?.[0],
        private: (metadata.private as boolean | undefined) ?? false,
        created_at: metadata.created_at as string | undefined,
        modified_at: metadata.modified_at as string | undefined,
    };
}

/** Build a FullStory response from raw story data. */
function toFullStory(id: string, metadata: Record<string, unknown>, content: string, mentions: string[]): FullStory {
    return { id, metadata: metadata as FullStory['metadata'], content: content.replace(/^\n/, '').trimEnd(), mentions };
}

/** Write a story file to disk and return its parsed FullStory representation. */
async function writeStoryFile(
    id: string,
    metadata: Record<string, unknown>,
    content: string,
    writeFn: (relativePath: string, fileContent: string) => Promise<void>
): Promise<FullStory> {
    const parsed = StorySchema.parse(metadata);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- gray-matter stringify expects object type incompatible with Zod output
    const fileContent = matter.stringify(content, parsed as any);
    await writeFn(path.join('stories', `${id}.md`), fileContent);
    const mentions = extractMentions(content);
    return toFullStory(id, parsed, content, mentions);
}

const STORY_NOT_FOUND = { error: 'Story not found', code: 'STORY_NOT_FOUND' } as const;

/** Build a person-name resolver from the in-memory graph. */
function makePersonNameResolver(graphEngine: AppInstance['appServices']['graphEngine']): (id: string) => string {
    const graph = graphEngine.getGraph();
    return (personId: string) => {
        const nodeAttrs = graph.hasNode(personId) ? graph.getNodeAttributes(personId) : null;
        const slim = nodeAttrs?.data as SlimPerson | undefined;
        if (!slim?.names?.[0]) return personId;
        const n = slim.names[0];
        return [n.first, n.last].filter(Boolean).join(' ') || personId;
    };
}

export async function storiesRoutes(server: FastifyInstance) {
    const { graphEngine, txManager, dataDir } = (server as AppInstance).appServices;
    const storiesDir = path.join(dataDir, 'stories');

    // Ensure stories directory exists
    await fs.mkdir(storiesDir, { recursive: true });

    // ── GET /api/stories ──────────────────────────────────────────────────

    server.get<{
        Querystring: { limit?: string; offset?: string; sort?: string; personIds?: string; q?: string }
    }>('/api/stories', async (request, reply) => {
        const { limit: limitStr, offset: offsetStr, sort, personIds, q } = request.query;

        const limit = limitStr !== undefined ? parseInt(limitStr, 10) : 50;
        const offset = offsetStr !== undefined ? parseInt(offsetStr, 10) : 0;

        if (isNaN(limit) || limit < 0 || limit > 200) {
            return reply.status(400).send({ error: 'limit must be between 0 and 200', code: 'VALIDATION_ERROR' });
        }
        if (isNaN(offset) || offset < 0) {
            return reply.status(400).send({ error: 'offset must be >= 0', code: 'VALIDATION_ERROR' });
        }

        // Read all .md files from the stories directory
        let files: string[];
        try {
            files = (await fs.readdir(storiesDir)).filter(f => f.endsWith('.md'));
        } catch {
            files = [];
        }

        const resolvePersonName = makePersonNameResolver(graphEngine);
        let feedItems: StoryFeedItem[] = [];
        for (const file of files) {
            try {
                const raw = await fs.readFile(path.join(storiesDir, file), 'utf8');
                const { data, content } = matter(raw);
                const metadata = StorySchema.parse(data);
                const mentions = extractMentions(content);
                feedItems.push(toFeedItem(filenameToId(file), metadata, content, mentions, resolvePersonName));
            } catch {
                // Skip malformed story files
            }
        }

        // Sort: newest first by default (using date string), then oldest, then alphabetical
        if (sort === 'oldest') {
            feedItems.sort((a, b) => {
                if (!a.date && !b.date) return 0;
                if (!a.date) return 1;  // undated goes last
                if (!b.date) return -1;
                return a.date.localeCompare(b.date);
            });
        } else if (sort === 'alpha') {
            feedItems.sort((a, b) => a.title.localeCompare(b.title));
        } else if (sort === 'created_newest' || sort === 'created_oldest') {
            const dir = sort === 'created_newest' ? -1 : 1;
            feedItems.sort((a, b) => {
                if (!a.created_at && !b.created_at) return 0;
                if (!a.created_at) return 1;   // nulls sort last
                if (!b.created_at) return -1;
                return a.created_at.localeCompare(b.created_at) * dir;
            });
        } else if (sort === 'modified_newest' || sort === 'modified_oldest') {
            const dir = sort === 'modified_newest' ? -1 : 1;
            feedItems.sort((a, b) => {
                if (!a.modified_at && !b.modified_at) return 0;
                if (!a.modified_at) return 1;  // nulls sort last
                if (!b.modified_at) return -1;
                return a.modified_at.localeCompare(b.modified_at) * dir;
            });
        } else {
            // newest (default) — reverse chronological; undated go last
            feedItems.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
        }

        const filterPersonIds = personIds ? personIds.split(',').filter(Boolean) : [];
        if (filterPersonIds.length > 0) {
            feedItems = feedItems.filter(s =>
                filterPersonIds.every(pid => s.people.includes(pid))
            );
        }

        const searchQ = q?.trim();
        if (searchQ) {
            // Split query into words so "gene webster" matches "Gene E Webster" (word-based, not
            // contiguous-substring matching). Every word must appear somewhere in the matched field.
            const words = searchQ.toLowerCase().split(/\s+/).filter(Boolean);
            const allWordsIn = (text: string) => words.every(w => text.toLowerCase().includes(w));

            // Also resolve people whose names match the query (to find stories by tagged person).
            // Use searchPeopleIds to avoid the overhead of searching stories + places indexes.
            const matchingPersonIds = await graphEngine.searchService.searchPeopleIds(searchQ, 1000);

            feedItems = feedItems.filter(s =>
                allWordsIn(s.title) ||
                (s.place != null && allWordsIn(formatPlaceDisplay(s.place))) ||
                allWordsIn(s.excerpt) ||
                (matchingPersonIds.size > 0 && s.people.some(pid => matchingPersonIds.has(pid)))
            );
        }

        const totalCount = feedItems.length;
        return { stories: feedItems.slice(offset, offset + limit), totalCount };
    });

    // ── GET /api/stories/:id ──────────────────────────────────────────────

    server.get<{ Params: { id: string } }>('/api/stories/:id', async (request, reply) => {
        const { id } = request.params;
        if (!isSafePathSegment(id)) return reply.status(404).send(STORY_NOT_FOUND);
        const filePath = path.join(storiesDir, `${id}.md`);

        try {
            const raw = await fs.readFile(filePath, 'utf8');
            const { data, content } = matter(raw);
            const metadata = StorySchema.parse(data);
            const mentions = extractMentions(content);
            return toFullStory(id, metadata, content, mentions);
        } catch {
            return reply.status(404).send(STORY_NOT_FOUND);
        }
    });

    // ── POST /api/stories ─────────────────────────────────────────────────

    server.post<{
        Body: {
            title?: string;
            content?: string;
            date?: string;
            place?: string;
            people?: string[];
            tags?: string[];
            assets?: string[];
            private?: boolean;
        }
    }>('/api/stories', async (request, reply) => {
        const body = request.body;

        if (!body.title || typeof body.title !== 'string' || body.title.trim() === '') {
            return reply.status(400).send({ error: 'title is required', code: 'VALIDATION_ERROR' });
        }

        // Generate a slug-like ID from title + nanoid
        const slug = body.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 40);
        const id = `${slug}-${nanoid(8)}`;

        const now = new Date().toISOString();
        const metadata: Record<string, unknown> = {
            title: body.title.trim(),
            ...(body.date !== undefined && { date: body.date }),
            ...(body.place !== undefined && { place: body.place }),
            ...(body.people !== undefined && { people: body.people }),
            ...(body.tags !== undefined && { tags: body.tags }),
            ...(body.private !== undefined && { private: body.private }),
            assets: body.assets ?? [],
            created_at: now,
            modified_at: now,
        };

        const content = body.content ?? '';

        try {
            const story = await writeStoryFile(id, metadata, content,
                (rel, fc) => txManager.writeFile(rel, fc, `story ${id}`));
            await graphEngine.applyStoryWriteSideEffects(path.join(dataDir, 'stories', `${id}.md`));
            return reply.status(201).send(story);
        } catch (error: unknown) {
            return reply.status(400).send({ error: 'Invalid story data', code: 'VALIDATION_ERROR', details: error instanceof Error ? error.message : String(error) });
        }
    });

    // ── PUT /api/stories/:id ──────────────────────────────────────────────

    server.put<{
        Params: { id: string };
        Body: {
            title?: string;
            content?: string;
            date?: string;
            place?: string;
            people?: string[];
            tags?: string[];
            assets?: string[];
            private?: boolean;
        }
    }>('/api/stories/:id', async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        if (!isSafePathSegment(id)) return reply.status(404).send(STORY_NOT_FOUND);
        const filePath = path.join(storiesDir, `${id}.md`);

        // Load existing
        let existing: { data: Record<string, unknown>; content: string };
        try {
            const raw = await fs.readFile(filePath, 'utf8');
            const parsed = matter(raw);
            existing = { data: parsed.data, content: parsed.content };
        } catch {
            return reply.status(404).send(STORY_NOT_FOUND);
        }

        // Validate and normalize title if provided
        if (body.title !== undefined) {
            const trimmed = body.title.trim();
            if (!trimmed) {
                return reply.status(400).send({ error: 'Title must not be empty', code: 'VALIDATION_ERROR' });
            }
            body.title = trimmed;
        }

        // Merge updates — preserve created_at, bump modified_at
        const metadata: Record<string, unknown> = {
            ...existing.data,
            ...(body.title !== undefined && { title: body.title }),
            ...(body.date !== undefined && { date: body.date }),
            ...(body.place !== undefined && { place: body.place }),
            ...(body.people !== undefined && { people: body.people }),
            ...(body.tags !== undefined && { tags: body.tags }),
            ...(body.assets !== undefined && { assets: body.assets }),
            ...(body.private !== undefined && { private: body.private }),
            modified_at: new Date().toISOString(),
        };
        const content = body.content !== undefined ? body.content : existing.content;

        try {
            const story = await writeStoryFile(id, metadata, content,
                (rel, fc) => txManager.writeFile(rel, fc, `story ${id}`));
            await graphEngine.applyStoryWriteSideEffects(path.join(dataDir, 'stories', `${id}.md`));
            return reply.status(200).send(story);
        } catch (error: unknown) {
            return reply.status(400).send({ error: 'Invalid story data', code: 'VALIDATION_ERROR', details: error instanceof Error ? error.message : String(error) });
        }
    });

    // ── DELETE /api/stories/:id ───────────────────────────────────────────

    server.delete<{ Params: { id: string } }>('/api/stories/:id', async (request, reply) => {
        const { id } = request.params;
        if (!isSafePathSegment(id)) return reply.status(404).send(STORY_NOT_FOUND);
        const filePath = path.join(storiesDir, `${id}.md`);

        // Read story before deleting so we know which assets to consider for cleanup.
        let storyAssets: string[] = [];
        try {
            const raw = await fs.readFile(filePath, 'utf8');
            const { data } = matter(raw);
            storyAssets = Array.isArray(data.assets) ? data.assets : [];
        } catch {
            return reply.status(404).send(STORY_NOT_FOUND);
        }

        await fs.unlink(filePath);
        await txManager.removeFile(path.join('stories', `${id}.md`), `story ${id}`);

        // Clean up orphaned assets — delete any asset that is no longer referenced
        // by any remaining story (frontmatter assets list) or any person (assets array).
        if (storyAssets.length > 0) {
            // Collect all assets still referenced by remaining stories
            const referencedByStories = new Set<string>();
            try {
                const remainingFiles = (await fs.readdir(storiesDir)).filter(f => f.endsWith('.md'));
                for (const file of remainingFiles) {
                    try {
                        const raw = await fs.readFile(path.join(storiesDir, file), 'utf8');
                        const { data } = matter(raw);
                        if (Array.isArray(data.assets)) {
                            for (const a of data.assets) referencedByStories.add(a);
                        }
                    } catch { /* skip malformed */ }
                }
            } catch { /* stories dir unreadable */ }

            // Collect all assets referenced by people (from in-memory graph)
            const referencedByPeople = new Set<string>();
            const graph = graphEngine.getGraph();
            graph.forEachNode((_nodeId, attrs) => {
                const personAssets: unknown[] = (attrs?.data as SlimPerson | undefined)?.assets ?? [];
                for (const a of personAssets) {
                    if (typeof a === 'string') referencedByPeople.add(a);
                }
            });

            // Delete asset files that are no longer referenced anywhere
            for (const asset of storyAssets) {
                // Asset names come from client-supplied frontmatter; never unlink outside assets/
                if (!isSafePathSegment(asset)) continue;
                if (!referencedByStories.has(asset) && !referencedByPeople.has(asset)) {
                    try {
                        await fs.unlink(path.join(dataDir, 'assets', asset));
                        await txManager.removeFile(path.join('assets', asset), `asset ${asset}`);
                    } catch { /* already gone or inaccessible — ignore */ }
                }
            }
        }

        graphEngine.applyStoryDeleteSideEffects(filePath);
        return reply.status(204).send();
    });

    // ── DELETE /api/stories/:id/media/:filename ───────────────────────────

    server.delete<{ Params: { id: string; filename: string } }>('/api/stories/:id/media/:filename', async (request, reply) => {
        const { id, filename } = request.params;
        if (!isSafePathSegment(id)) return reply.status(404).send(STORY_NOT_FOUND);
        if (!isSafePathSegment(filename)) {
            return reply.status(404).send({ error: 'Asset not found', code: 'ASSET_NOT_FOUND' });
        }
        const filePath = path.join(storiesDir, `${id}.md`);

        let existingRaw: string;
        try {
            existingRaw = await fs.readFile(filePath, 'utf8');
        } catch {
            return reply.status(404).send(STORY_NOT_FOUND);
        }

        // Remove asset file from disk (best-effort)
        const assetPath = path.join(dataDir, 'assets', filename);
        try {
            await fs.unlink(assetPath);
            await txManager.removeFile(path.join('assets', filename), `asset ${filename}`);
        } catch { /* already gone */ }

        // Remove reference from story frontmatter
        const { data: frontmatter, content } = matter(existingRaw);
        const currentAssets: string[] = Array.isArray(frontmatter.assets) ? frontmatter.assets : [];
        const updatedMetadata = {
            ...frontmatter,
            assets: currentAssets.filter((a: string) => a !== filename),
            modified_at: new Date().toISOString(),
        };

        const story = await writeStoryFile(id, updatedMetadata, content,
            (rel, fc) => txManager.writeFile(rel, fc, `story ${id}`));
        await graphEngine.applyStoryWriteSideEffects(path.join(dataDir, 'stories', `${id}.md`));
        return reply.status(200).send(story);
    });

    // ── PUT /api/stories/:id/media ────────────────────────────────────────

    server.put<{ Params: { id: string } }>('/api/stories/:id/media', async (request, reply) => {
        const { id } = request.params;
        if (!isSafePathSegment(id)) return reply.status(404).send(STORY_NOT_FOUND);
        const filePath = path.join(storiesDir, `${id}.md`);

        // Verify story exists
        let existingRaw: string;
        try {
            existingRaw = await fs.readFile(filePath, 'utf8');
        } catch {
            return reply.status(404).send(STORY_NOT_FOUND);
        }

        let data: Awaited<ReturnType<import('fastify').FastifyRequest['file']>> | undefined;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fastify multipart plugin adds .file() dynamically
            data = await (request as any).file();
        } catch (err: unknown) {
            if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
                return reply.status(400).send({ error: 'Request must be multipart/form-data', code: 'VALIDATION_ERROR' });
            }
            throw err;
        }
        if (!data) {
            return reply.status(400).send({ error: 'No file uploaded', code: 'VALIDATION_ERROR' });
        }

        const assetsDir = path.join(dataDir, 'assets');
        await fs.mkdir(assetsDir, { recursive: true });

        const ext = path.extname(data.filename) || '.bin';
        const filename = `${nanoid(12)}${ext}`;
        const destPath = path.join(assetsDir, filename);

        await pipeline(data.file, nodeFs.createWriteStream(destPath));
        await txManager.trackFile(path.join('assets', filename), `asset ${filename}`);

        // Update story frontmatter to include the new asset
        const { data: frontmatter, content } = matter(existingRaw);
        const currentAssets: string[] = Array.isArray(frontmatter.assets) ? frontmatter.assets : [];
        const updatedMetadata = {
            ...frontmatter,
            assets: [...currentAssets, filename],
            modified_at: new Date().toISOString(),
        };

        const story = await writeStoryFile(id, updatedMetadata, content,
            (rel, fc) => txManager.writeFile(rel, fc, `story ${id}`));
        await graphEngine.applyStoryWriteSideEffects(path.join(dataDir, 'stories', `${id}.md`));

        return reply.status(200).send(story);
    });
}
