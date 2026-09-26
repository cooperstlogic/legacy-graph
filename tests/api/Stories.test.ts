// tests/api/Stories.test.ts
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server';
import supertest from 'supertest';
import git from 'isomorphic-git';
import * as fs from 'fs';
import * as path from 'path';
import { createFixtureDataDir } from '../fixtures/fixtureDataDir';

// Own copy of the fixture data: test files run in parallel (see fixtureDataDir.ts)
const TEST_DATA_DIR = createFixtureDataDir('stories-test');
const STORIES_DIR = path.join(TEST_DATA_DIR, 'stories');

function cleanupStories() {
    if (fs.existsSync(STORIES_DIR)) {
        const files = fs.readdirSync(STORIES_DIR).filter(f => f.startsWith('test-'));
        for (const file of files) {
            fs.unlinkSync(path.join(STORIES_DIR, file));
        }
    }
}

describe('Stories API', () => {
    let server: FastifyInstance;
    let request: ReturnType<typeof supertest>;

    beforeEach(async () => {
        const gitDir = path.join(TEST_DATA_DIR, '.git');
        if (!fs.existsSync(gitDir)) {
            await git.init({ fs, dir: TEST_DATA_DIR });
            await git.setConfig({ fs, dir: TEST_DATA_DIR, path: 'user.name', value: 'Test User' });
            await git.setConfig({ fs, dir: TEST_DATA_DIR, path: 'user.email', value: 'test@example.com' });
            const gitignorePath = path.join(TEST_DATA_DIR, '.gitignore');
            fs.writeFileSync(gitignorePath, '# Test git repo\n');
            await git.add({ fs, dir: TEST_DATA_DIR, filepath: '.gitignore' });
            await git.commit({
                fs,
                dir: TEST_DATA_DIR,
                message: 'Initial commit',
                author: { name: 'Test User', email: 'test@example.com' }
            });
        }

        const authPath = path.join(TEST_DATA_DIR, '_meta', 'auth.yaml');
        if (fs.existsSync(authPath)) fs.unlinkSync(authPath);

        if (!fs.existsSync(STORIES_DIR)) fs.mkdirSync(STORIES_DIR, { recursive: true });

        server = await createServer({ logger: false, dataDir: TEST_DATA_DIR });
        await server.listen({ port: 0 });
        const address = server.server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 3000;
        request = supertest(`http://localhost:${port}`);
    });

    afterEach(async () => {
        await server.close();
        cleanupStories();
    });

    afterAll(() => {
        cleanupStories();
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    });

    // ── List ────────────────────────────────────────────────────────────────

    it('GET /api/stories returns empty list when no stories exist', async () => {
        // Remove any existing story files that could bleed in
        const storyFiles = fs.readdirSync(STORIES_DIR);
        for (const f of storyFiles) fs.unlinkSync(path.join(STORIES_DIR, f));

        const res = await request.get('/api/stories');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('stories');
        expect(res.body).toHaveProperty('totalCount');
        expect(Array.isArray(res.body.stories)).toBe(true);
    });

    it('GET /api/stories supports pagination via limit + offset', async () => {
        const res = await request.get('/api/stories?limit=5&offset=0');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('totalCount');
        expect(res.body.stories.length).toBeLessThanOrEqual(5);
    });

    it('GET /api/stories returns 400 for invalid limit', async () => {
        const res = await request.get('/api/stories?limit=999');
        expect(res.status).toBe(400);
    });

    // ── Create ──────────────────────────────────────────────────────────────

    it('POST /api/stories creates a new story and returns it', async () => {
        const res = await request.post('/api/stories').send({
            title: 'Test Story Title',
            content: 'The body of the story.',
        });
        expect(res.status).toBe(201);
        expect(res.body.metadata.title).toBe('Test Story Title');
        expect(res.body.content).toBe('The body of the story.');
        expect(typeof res.body.id).toBe('string');

        // File must exist on disk
        const filePath = path.join(STORIES_DIR, `${res.body.id}.md`);
        expect(fs.existsSync(filePath)).toBe(true);
    });

    it('POST /api/stories with place and date persists frontmatter', async () => {
        const res = await request.post('/api/stories').send({
            title: 'Test Placed Story',
            date: '1939-1945',
            place: 'London, England',
            content: 'A wartime story.',
        });
        expect(res.status).toBe(201);
        expect(res.body.metadata.place).toEqual({ name: 'London, England' });
        expect(res.body.metadata.date).toBe('1939-1945');
    });

    it('POST /api/stories returns 400 when title is missing', async () => {
        const res = await request.post('/api/stories').send({ content: 'No title here.' });
        expect(res.status).toBe(400);
    });

    // ── Read ────────────────────────────────────────────────────────────────

    it('GET /api/stories/:id returns full story', async () => {
        const created = await request.post('/api/stories').send({
            title: 'Test Read Story',
            content: 'Full content here.',
        });
        expect(created.status).toBe(201);
        const id = created.body.id;

        const res = await request.get(`/api/stories/${id}`);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(id);
        expect(res.body.metadata.title).toBe('Test Read Story');
        expect(res.body.content).toBe('Full content here.');
    });

    it('GET /api/stories/:id returns 404 for unknown id', async () => {
        const res = await request.get('/api/stories/test-nonexistent-story');
        expect(res.status).toBe(404);
    });

    // ── Update ──────────────────────────────────────────────────────────────

    it('PUT /api/stories/:id updates title and content', async () => {
        const created = await request.post('/api/stories').send({
            title: 'Test Original Title',
            content: 'Original body.',
        });
        expect(created.status).toBe(201);
        const id = created.body.id;

        const res = await request.put(`/api/stories/${id}`).send({
            title: 'Test Updated Title',
            content: 'Updated body.',
        });
        expect(res.status).toBe(200);
        expect(res.body.metadata.title).toBe('Test Updated Title');
        expect(res.body.content).toBe('Updated body.');
    });

    it('PUT /api/stories/:id returns 404 for unknown id', async () => {
        const res = await request.put('/api/stories/test-nonexistent-story').send({
            title: 'Doesn\'t matter',
            content: 'Nope.',
        });
        expect(res.status).toBe(404);
    });

    // ── Delete ──────────────────────────────────────────────────────────────

    it('DELETE /api/stories/:id removes the story and returns 204', async () => {
        const created = await request.post('/api/stories').send({
            title: 'Test Delete Me',
            content: 'Gone soon.',
        });
        expect(created.status).toBe(201);
        const id = created.body.id;
        const filePath = path.join(STORIES_DIR, `${id}.md`);

        const del = await request.delete(`/api/stories/${id}`);
        expect(del.status).toBe(204);
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it('DELETE /api/stories/:id returns 404 for unknown id', async () => {
        const res = await request.delete('/api/stories/test-nonexistent-story');
        expect(res.status).toBe(404);
    });

    // ── Mention Extraction ──────────────────────────────────────────────────

    it('POST /api/stories parses @mentions from body', async () => {
        const res = await request.post('/api/stories').send({
            title: 'Test Mention Story',
            content: 'This mentions @N_graph-parent-i3ktui9x in the body.',
        });
        expect(res.status).toBe(201);
        expect(res.body.mentions).toContain('N_graph-parent-i3ktui9x');
    });

    it('POST /api/stories parses [[wikilink]] mentions from body', async () => {
        const res = await request.post('/api/stories').send({
            title: 'Test Wikilink Story',
            content: 'This mentions [[N_graph-parent-i3ktui9x]] via wikilink.',
        });
        expect(res.status).toBe(201);
        expect(res.body.mentions).toContain('N_graph-parent-i3ktui9x');
    });

    it('GET /api/stories list combines metadata.people and body mentions in people field', async () => {
        const person1 = 'N_graph-parent-i3ktui9x';
        const person2 = 'N_graph-child-vb709p2s';
        const created = await request.post('/api/stories').send({
            title: 'Test People Field Story',
            people: [person1],
            content: `This also mentions @${person2} inline.`,
        });
        expect(created.status).toBe(201);
        const id = created.body.id;

        const res = await request.get('/api/stories');
        expect(res.status).toBe(200);
        const story = res.body.stories.find((s: any) => s.id === id);
        expect(story).toBeDefined();
        expect(story.people).toContain(person1);
        expect(story.people).toContain(person2);
    });

    // ── StoryFeedItem shape ─────────────────────────────────────────────────

    it('GET /api/stories list returns StoryFeedItem shape', async () => {
        const created = await request.post('/api/stories').send({
            title: 'Test Feed Shape',
            content: 'A'.repeat(300),
        });
        expect(created.status).toBe(201);
        const id = created.body.id;

        const res = await request.get('/api/stories');
        expect(res.status).toBe(200);
        const story = res.body.stories.find((s: any) => s.id === id);
        expect(story).toBeDefined();
        expect(typeof story.id).toBe('string');
        expect(typeof story.title).toBe('string');
        expect(typeof story.excerpt).toBe('string');
        // Excerpt must be truncated at 280 chars
        expect(story.excerpt.length).toBeLessThanOrEqual(280);
        expect(Array.isArray(story.people)).toBe(true);
        expect(typeof story.private).toBe('boolean');
    });

    // ── Media Attachment ────────────────────────────────────────────────────

    it('PUT /api/stories/:id/media attaches an asset to a story', async () => {
        const created = await request.post('/api/stories').send({
            title: 'Test Media Story',
            content: 'Story with a photo.',
        });
        expect(created.status).toBe(201);
        const id = created.body.id;

        // Create a minimal PNG buffer (1x1 white pixel)
        const pngBuffer = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==',
            'base64'
        );

        const res = await request
            .put(`/api/stories/${id}/media`)
            .attach('file', pngBuffer, 'test-photo.png');

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.metadata.assets)).toBe(true);
        expect(res.body.metadata.assets.length).toBeGreaterThan(0);

        // Asset file must exist on disk
        const assetsDir = path.join(TEST_DATA_DIR, 'assets');
        const assets: string[] = res.body.metadata.assets;
        const assetFile = assets[assets.length - 1];
        expect(fs.existsSync(path.join(assetsDir, assetFile))).toBe(true);
    });

    // ── Sorting ─────────────────────────────────────────────────────────────

    it('GET /api/stories?sort=oldest returns oldest-first order', async () => {
        const res = await request.get('/api/stories?sort=oldest');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.stories)).toBe(true);
    });

    // ── personIds filter ─────────────────────────────────────────────────────

    describe('GET /api/stories with personIds filter', () => {
        it('returns only stories mentioning a specific person', async () => {
            const personA = 'N_test-filter-aaa';
            const personB = 'N_test-filter-bbb';

            const [r1, r2] = await Promise.all([
                request.post('/api/stories').send({
                    title: 'Test Filter Story A',
                    people: [personA],
                    content: 'Mentions person A.',
                }),
                request.post('/api/stories').send({
                    title: 'Test Filter Story B',
                    people: [personB],
                    content: 'Mentions person B.',
                }),
            ]);
            expect(r1.status).toBe(201);
            expect(r2.status).toBe(201);

            const res = await request.get(`/api/stories?personIds=${personA}`);
            expect(res.status).toBe(200);
            const ids = res.body.stories.map((s: any) => s.id);
            expect(ids).toContain(r1.body.id);
            expect(ids).not.toContain(r2.body.id);
        });

        it('returns only stories mentioning ALL specified people (AND filter)', async () => {
            const personA = 'N_test-and-aaa';
            const personB = 'N_test-and-bbb';

            const [rBoth, rAOnly] = await Promise.all([
                request.post('/api/stories').send({
                    title: 'Test And Both Story',
                    people: [personA, personB],
                    content: 'Mentions both.',
                }),
                request.post('/api/stories').send({
                    title: 'Test And A Only Story',
                    people: [personA],
                    content: 'Mentions only A.',
                }),
            ]);
            expect(rBoth.status).toBe(201);
            expect(rAOnly.status).toBe(201);

            const res = await request.get(`/api/stories?personIds=${personA},${personB}`);
            expect(res.status).toBe(200);
            const ids = res.body.stories.map((s: any) => s.id);
            expect(ids).toContain(rBoth.body.id);
            expect(ids).not.toContain(rAOnly.body.id);
        });

        it('personIds filter preserves sort order', async () => {
            const personC = 'N_test-sort-ccc';

            const [rOld, rNew] = await Promise.all([
                request.post('/api/stories').send({
                    title: 'Test Sort Old Story',
                    date: '1900-01-01',
                    people: [personC],
                    content: 'Older story.',
                }),
                request.post('/api/stories').send({
                    title: 'Test Sort New Story',
                    date: '2000-01-01',
                    people: [personC],
                    content: 'Newer story.',
                }),
            ]);
            expect(rOld.status).toBe(201);
            expect(rNew.status).toBe(201);

            const res = await request.get(`/api/stories?sort=oldest&personIds=${personC}`);
            expect(res.status).toBe(200);
            const ids = res.body.stories.map((s: any) => s.id);
            expect(ids).toContain(rOld.body.id);
            expect(ids).toContain(rNew.body.id);
            // Oldest-first: old story should appear before new story
            expect(ids.indexOf(rOld.body.id)).toBeLessThan(ids.indexOf(rNew.body.id));
        });
    });

    // ── q search (text + person-name) ───────────────────────────────────────

    describe('GET /api/stories with q= text search', () => {
        it('finds stories where all search words appear in title (words separated by middle initial)', async () => {
            const created = await request.post('/api/stories').send({
                title: 'Test Gene E Webster Memorial Story',
                content: 'Some content here.',
            });
            expect(created.status).toBe(201);

            // "gene webster" — both words in title but "E" (middle initial) separates them
            const res = await request.get('/api/stories?q=gene+webster');
            expect(res.status).toBe(200);
            const ids = res.body.stories.map((s: any) => s.id);
            expect(ids).toContain(created.body.id);
        });

        it('finds stories by tagged person name when person has middle initial', async () => {
            const PEOPLE_DIR = path.join(TEST_DATA_DIR, 'people');
            fs.mkdirSync(PEOPLE_DIR, { recursive: true });
            let personId: string | undefined;
            try {
                const personRes = await request.post('/api/people').send({
                    names: [{ first: 'StorySearch E', last: 'PersonName' }],
                    sex: 'M',
                });
                expect(personRes.status).toBe(201);
                personId = personRes.body.id;

                const storyRes = await request.post('/api/stories').send({
                    title: 'Test Tagged Person Search Story',
                    people: [personId],
                    content: 'A story about a tagged person.',
                });
                expect(storyRes.status).toBe(201);

                // Search by first+last (skipping middle initial "E")
                const res = await request.get('/api/stories?q=StorySearch+PersonName');
                expect(res.status).toBe(200);
                const ids = res.body.stories.map((s: any) => s.id);
                expect(ids).toContain(storyRes.body.id);
            } finally {
                if (personId) {
                    try { fs.unlinkSync(path.join(PEOPLE_DIR, `${personId}.yaml`)); } catch { /* ignore */ }
                }
            }
        });
    });

    // ── Timestamps ──────────────────────────────────────────────────────────

    it('POST /api/stories sets created_at and modified_at in frontmatter', async () => {
        const before = new Date().toISOString();
        const res = await request.post('/api/stories').send({
            title: 'Test Timestamp Story',
            content: 'Checking timestamps.',
        });
        const after = new Date().toISOString();

        expect(res.status).toBe(201);
        const id = res.body.id;

        const filePath = path.join(STORIES_DIR, `${id}.md`);
        const raw = fs.readFileSync(filePath, 'utf8');
        const matter = await import('gray-matter');
        const { data } = matter.default(raw);

        expect(typeof data.created_at).toBe('string');
        expect(typeof data.modified_at).toBe('string');
        expect(data.created_at >= before).toBe(true);
        expect(data.created_at <= after).toBe(true);
        expect(data.modified_at).toBe(data.created_at);
    });

    it('GET /api/stories includes created_at and modified_at in feed items', async () => {
        const res = await request.post('/api/stories').send({
            title: 'Test Feed Timestamps',
            content: 'Feed timestamp test.',
        });
        expect(res.status).toBe(201);
        const id = res.body.id;

        const listRes = await request.get('/api/stories');
        expect(listRes.status).toBe(200);
        const story = listRes.body.stories.find((s: any) => s.id === id);
        expect(story).toBeDefined();
        expect(typeof story.created_at).toBe('string');
        expect(typeof story.modified_at).toBe('string');
    });

    it('PUT /api/stories/:id updates modified_at but preserves created_at', async () => {
        const createRes = await request.post('/api/stories').send({
            title: 'Test Preserve created_at',
            content: 'Original.',
        });
        expect(createRes.status).toBe(201);
        const id = createRes.body.id;
        const originalCreatedAt = createRes.body.metadata.created_at;
        expect(typeof originalCreatedAt).toBe('string');

        // Small delay to ensure modified_at will differ
        await new Promise(r => setTimeout(r, 10));

        const updateRes = await request.put(`/api/stories/${id}`).send({
            title: 'Test Updated Title',
            content: 'Updated.',
        });
        expect(updateRes.status).toBe(200);
        expect(updateRes.body.metadata.created_at).toBe(originalCreatedAt);
        expect(updateRes.body.metadata.modified_at).not.toBe(originalCreatedAt);
        expect(updateRes.body.metadata.modified_at > originalCreatedAt).toBe(true);
    });

    it('GET /api/stories?sort=created_newest returns most recently created first', async () => {
        const r1 = await request.post('/api/stories').send({ title: 'Test Created First', content: '' });
        await new Promise(r => setTimeout(r, 15));
        const r2 = await request.post('/api/stories').send({ title: 'Test Created Second', content: '' });
        expect(r1.status).toBe(201);
        expect(r2.status).toBe(201);

        const res = await request.get('/api/stories?sort=created_newest');
        expect(res.status).toBe(200);
        const ids = res.body.stories.map((s: any) => s.id);
        expect(ids.indexOf(r2.body.id)).toBeLessThan(ids.indexOf(r1.body.id));
    });

    it('GET /api/stories?sort=modified_newest returns most recently modified first', async () => {
        const r1 = await request.post('/api/stories').send({ title: 'Test Mod First', content: '' });
        const r2 = await request.post('/api/stories').send({ title: 'Test Mod Second', content: '' });
        expect(r1.status).toBe(201);
        expect(r2.status).toBe(201);

        await new Promise(r => setTimeout(r, 15));
        // Update r1 — it should now have the most recent modified_at
        const updateRes = await request.put(`/api/stories/${r1.body.id}`).send({ content: 'Updated.' });
        expect(updateRes.status).toBe(200);

        const res = await request.get('/api/stories?sort=modified_newest');
        expect(res.status).toBe(200);
        const ids = res.body.stories.map((s: any) => s.id);
        expect(ids.indexOf(r1.body.id)).toBeLessThan(ids.indexOf(r2.body.id));
    });

    it('GET /api/stories legacy files without created_at sort last for sort=created_newest', async () => {
        // Write a raw .md file without timestamps (simulates old file)
        const legacyContent = `---\ntitle: Test Legacy No Timestamps\n---\nLegacy content.\n`;
        const legacyId = 'test-legacy-no-timestamps';
        fs.writeFileSync(path.join(STORIES_DIR, `${legacyId}.md`), legacyContent);

        const apiRes = await request.post('/api/stories').send({
            title: 'Test API Created With Timestamps',
            content: '',
        });
        expect(apiRes.status).toBe(201);

        const res = await request.get('/api/stories?sort=created_newest');
        expect(res.status).toBe(200);
        const ids = res.body.stories.map((s: any) => s.id);
        // API-created (has created_at) appears before legacy (no created_at)
        expect(ids.indexOf(apiRes.body.id)).toBeLessThan(ids.indexOf(legacyId));

        // Cleanup
        try { fs.unlinkSync(path.join(STORIES_DIR, `${legacyId}.md`)); } catch { /* ignore */ }
    });
});
