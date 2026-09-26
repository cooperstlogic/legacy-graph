// tests/api/Assets.test.ts
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server';
import supertest from 'supertest';
import git from 'isomorphic-git';
import * as fs from 'fs';
import * as path from 'path';
import { createFixtureDataDir } from '../fixtures/fixtureDataDir';

// Own copy of the fixture data: test files run in parallel (see fixtureDataDir.ts)
const TEST_DATA_DIR = createFixtureDataDir('assets-test');
const ASSETS_DIR = path.join(TEST_DATA_DIR, 'assets');
const META_DIR = path.join(TEST_DATA_DIR, '_meta');

const TEST_ASSET = 'test-asset-gallery.png';
const TEST_ASSET_PATH = path.join(ASSETS_DIR, TEST_ASSET);

function ensureGitRepo() {
    const gitDir = path.join(TEST_DATA_DIR, '.git');
    return gitDir;
}

async function setupGit() {
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
}

const PEOPLE_DIR = path.join(TEST_DATA_DIR, 'people');
// Track person IDs created by this test file so cleanup only removes our own files
const createdPersonIds = new Set<string>();

function cleanupTestAssets() {
    if (fs.existsSync(ASSETS_DIR)) {
        const files = fs.readdirSync(ASSETS_DIR).filter(f => f.startsWith('test-asset'));
        for (const file of files) {
            try { fs.unlinkSync(path.join(ASSETS_DIR, file)); } catch { /* ignore */ }
        }
    }
    const metaAssetsYaml = path.join(META_DIR, 'assets.yaml');
    if (fs.existsSync(metaAssetsYaml)) {
        try { fs.unlinkSync(metaAssetsYaml); } catch { /* ignore */ }
    }
    // Only clean up person YAML files created by this test file (safe for parallel runs)
    for (const id of createdPersonIds) {
        try { fs.unlinkSync(path.join(PEOPLE_DIR, `${id}.yaml`)); } catch { /* ignore */ }
    }
    createdPersonIds.clear();
}

function writeTestAsset(filename = TEST_ASSET) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    // Write a minimal 1x1 PNG (89 bytes)
    const pngBytes = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000020001e221bc330000000049454e44ae426082',
        'hex'
    );
    fs.writeFileSync(path.join(ASSETS_DIR, filename), pngBytes);
}

describe('Assets API', () => {
    let server: FastifyInstance;
    let request: ReturnType<typeof supertest>;

    beforeEach(async () => {
        ensureGitRepo();
        await setupGit();

        const authPath = path.join(TEST_DATA_DIR, '_meta', 'auth.yaml');
        if (fs.existsSync(authPath)) fs.unlinkSync(authPath);

        fs.mkdirSync(ASSETS_DIR, { recursive: true });
        cleanupTestAssets();

        server = await createServer({ logger: false, dataDir: TEST_DATA_DIR });
        await server.listen({ port: 0 });
        const address = server.server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 3000;
        request = supertest(`http://localhost:${port}`);
    });

    afterEach(async () => {
        await server.close();
        cleanupTestAssets();
    });

    afterAll(() => {
        cleanupTestAssets();
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    });

    // ── GET /api/assets ──────────────────────────────────────────────────────

    it('GET /api/assets returns empty list when no files', async () => {
        if (fs.existsSync(ASSETS_DIR)) {
            const files = fs.readdirSync(ASSETS_DIR).filter(f => f.startsWith('test-'));
            for (const f of files) fs.unlinkSync(path.join(ASSETS_DIR, f));
        }

        const res = await request.get('/api/assets');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('assets');
        expect(res.body).toHaveProperty('totalCount');
        expect(Array.isArray(res.body.assets)).toBe(true);
    });

    it('GET /api/assets includes file with correct size and isOrphan: true when unreferenced', async () => {
        writeTestAsset();

        const res = await request.get('/api/assets');
        expect(res.status).toBe(200);

        const item = res.body.assets.find((a: any) => a.filename === TEST_ASSET);
        expect(item).toBeDefined();
        expect(item.size).toBeGreaterThan(0);
        expect(item.isOrphan).toBe(true);
        expect(item.mimeType).toBe('image/png');
        expect(item.referencedBy.people).toEqual([]);
        expect(item.referencedBy.stories).toEqual([]);
        expect(item.referencedBy.events).toEqual([]);
    });

    it('GET /api/assets metadata has description (not caption) and no tagged_people', async () => {
        writeTestAsset();

        const res = await request.get('/api/assets');
        expect(res.status).toBe(200);

        const item = res.body.assets.find((a: any) => a.filename === TEST_ASSET);
        expect(item).toBeDefined();
        expect(item.metadata).toBeDefined();
        expect('tagged_people' in item.metadata).toBe(false);
        expect('caption' in item.metadata).toBe(false);
        // description and date_taken may be undefined but not caption/tagged_people
    });

    it('GET /api/assets sets referencedBy.people correctly for person-owned asset', async () => {
        const createRes = await request.post('/api/people').send({
            names: [{ first: 'Asset', last: 'Tester' }],
            sex: 'U',
            assets: [TEST_ASSET],
        });
        expect(createRes.status).toBe(201);
        const personId = createRes.body.id;
        createdPersonIds.add(personId);

        writeTestAsset();

        const res = await request.get('/api/assets');
        expect(res.status).toBe(200);

        const item = res.body.assets.find((a: any) => a.filename === TEST_ASSET);
        expect(item).toBeDefined();
        expect(item.isOrphan).toBe(false);
        expect(item.referencedBy.people).toContain(personId);
    });

    it('GET /api/assets?type=image returns only image files', async () => {
        writeTestAsset('test-asset-gallery.png');
        // Also write a doc-type file
        fs.mkdirSync(ASSETS_DIR, { recursive: true });
        fs.writeFileSync(path.join(ASSETS_DIR, 'test-asset-gallery.pdf'), 'fake pdf');

        const res = await request.get('/api/assets?type=image');
        expect(res.status).toBe(200);

        const filenames = res.body.assets.map((a: any) => a.filename);
        expect(filenames).toContain('test-asset-gallery.png');
        expect(filenames).not.toContain('test-asset-gallery.pdf');

        // Cleanup
        try { fs.unlinkSync(path.join(ASSETS_DIR, 'test-asset-gallery.pdf')); } catch { /* ignore */ }
    });

    it('GET /api/assets?type=document returns only non-image files', async () => {
        writeTestAsset('test-asset-gallery.png');
        fs.mkdirSync(ASSETS_DIR, { recursive: true });
        fs.writeFileSync(path.join(ASSETS_DIR, 'test-asset-gallery.pdf'), 'fake pdf');

        const res = await request.get('/api/assets?type=document');
        expect(res.status).toBe(200);

        const filenames = res.body.assets.map((a: any) => a.filename);
        expect(filenames).not.toContain('test-asset-gallery.png');
        expect(filenames).toContain('test-asset-gallery.pdf');

        // Cleanup
        try { fs.unlinkSync(path.join(ASSETS_DIR, 'test-asset-gallery.pdf')); } catch { /* ignore */ }
    });

    it('GET /api/assets?sort=size&order=desc returns assets sorted by size descending', async () => {
        writeTestAsset('test-asset-gallery.png');
        // Write a larger file
        fs.writeFileSync(path.join(ASSETS_DIR, 'test-asset-gallery-big.png'), Buffer.alloc(1000, 0));

        const res = await request.get('/api/assets?sort=size&order=desc');
        expect(res.status).toBe(200);

        const sizes = (res.body.assets as any[])
            .filter((a: any) => a.filename.startsWith('test-asset-gallery'))
            .map((a: any) => a.size);
        // Should be descending
        for (let i = 1; i < sizes.length; i++) {
            expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
        }

        // Cleanup
        try { fs.unlinkSync(path.join(ASSETS_DIR, 'test-asset-gallery-big.png')); } catch { /* ignore */ }
    });

    it('GET /api/assets?q= filters by filename', async () => {
        writeTestAsset('test-asset-gallery.png');
        fs.writeFileSync(path.join(ASSETS_DIR, 'test-asset-unrelated.png'), Buffer.alloc(10, 0));

        const res = await request.get('/api/assets?q=gallery');
        expect(res.status).toBe(200);

        const filenames = res.body.assets.map((a: any) => a.filename);
        expect(filenames).toContain('test-asset-gallery.png');
        expect(filenames).not.toContain('test-asset-unrelated.png');

        // Cleanup
        try { fs.unlinkSync(path.join(ASSETS_DIR, 'test-asset-unrelated.png')); } catch { /* ignore */ }
    });

    it('GET /api/assets?q= filters by person display name', async () => {
        writeTestAsset();

        const createRes = await request.post('/api/people').send({
            names: [{ first: 'SearchableFirstName', last: 'SearchableLastName' }],
            sex: 'U',
            assets: [TEST_ASSET],
        });
        expect(createRes.status).toBe(201);
        const personId = createRes.body.id;
        createdPersonIds.add(personId);

        const res = await request.get('/api/assets?q=SearchableFirstName');
        expect(res.status).toBe(200);
        const item = res.body.assets.find((a: any) => a.filename === TEST_ASSET);
        expect(item).toBeDefined();
    });

    it('GET /api/assets?q= filters by multi-word person name with middle initial', async () => {
        writeTestAsset();
        let personId: string | undefined;
        try {
            const createRes = await request.post('/api/people').send({
                names: [{ first: 'AssetsSearch E', last: 'PersonSearch' }],
                sex: 'U',
                assets: [TEST_ASSET],
            });
            expect(createRes.status).toBe(201);
            personId = createRes.body.id;
            createdPersonIds.add(personId!);

            // Searching first+last skipping middle initial should match
            const res = await request.get('/api/assets?q=AssetsSearch+PersonSearch');
            expect(res.status).toBe(200);
            const item = res.body.assets.find((a: any) => a.filename === TEST_ASSET);
            expect(item).toBeDefined();
        } finally {
            if (personId) {
                try { fs.unlinkSync(path.join(TEST_DATA_DIR, 'people', `${personId}.yaml`)); } catch { /* ignore */ }
            }
        }
    });

    // ── PUT /api/assets/:filename/meta ───────────────────────────────────────

    it('PUT /api/assets/:filename/meta updates description', async () => {
        writeTestAsset();

        const res = await request
            .put(`/api/assets/${TEST_ASSET}/meta`)
            .send({ description: 'A test description' });

        expect(res.status).toBe(200);
        expect(res.body.description).toBe('A test description');
        expect('tagged_people' in res.body).toBe(false);

        // Verify persistence
        const metaYaml = path.join(META_DIR, 'assets.yaml');
        expect(fs.existsSync(metaYaml)).toBe(true);
    });

    it('PUT /api/assets/:filename/meta accepts legacy caption as description', async () => {
        writeTestAsset();

        const res = await request
            .put(`/api/assets/${TEST_ASSET}/meta`)
            .send({ caption: 'Legacy caption value' });

        expect(res.status).toBe(200);
        expect(res.body.description).toBe('Legacy caption value');
    });

    it('PUT /api/assets/:filename/meta updates date', async () => {
        writeTestAsset();

        const res = await request
            .put(`/api/assets/${TEST_ASSET}/meta`)
            .send({ date: '1945-06' });

        expect(res.status).toBe(200);
        expect(res.body.date).toBe('1945-06');
    });

    it('PUT /api/assets/:filename/meta accepts legacy date_taken as date', async () => {
        writeTestAsset();

        const res = await request
            .put(`/api/assets/${TEST_ASSET}/meta`)
            .send({ date_taken: '1945-06' });

        expect(res.status).toBe(200);
        expect(res.body.date).toBe('1945-06');
    });

    it('PUT /api/assets/:filename/meta creates assets.yaml if absent', async () => {
        writeTestAsset();
        const metaYaml = path.join(META_DIR, 'assets.yaml');
        if (fs.existsSync(metaYaml)) fs.unlinkSync(metaYaml);

        const res = await request
            .put(`/api/assets/${TEST_ASSET}/meta`)
            .send({ description: 'Created fresh' });

        expect(res.status).toBe(200);
        expect(fs.existsSync(metaYaml)).toBe(true);
    });

    it('PUT /api/assets/:filename/meta returns 404 for missing file', async () => {
        const res = await request
            .put('/api/assets/nonexistent-file.png/meta')
            .send({ description: 'wont work' });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ASSET_NOT_FOUND');
    });

    // ── DELETE /api/assets/:filename ─────────────────────────────────────────

    it('DELETE /api/assets/:filename deletes orphan and returns 204', async () => {
        writeTestAsset();

        const res = await request.delete(`/api/assets/${TEST_ASSET}`);
        expect(res.status).toBe(204);
        expect(fs.existsSync(TEST_ASSET_PATH)).toBe(false);
    });

    it('DELETE /api/assets/:filename returns 409 when asset is referenced by a person', async () => {
        writeTestAsset();

        const createRes = await request.post('/api/people').send({
            names: [{ first: 'Ref', last: 'Person' }],
            sex: 'U',
            assets: [TEST_ASSET],
        });
        expect(createRes.status).toBe(201);
        const personId = createRes.body.id;
        createdPersonIds.add(personId);

        const res = await request.delete(`/api/assets/${TEST_ASSET}`);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ASSET_REFERENCED');
        expect(res.body.referencedBy.people).toContain(personId);
        expect(fs.existsSync(TEST_ASSET_PATH)).toBe(true);
    });

    it('DELETE /api/assets/:filename returns 404 for missing file', async () => {
        const res = await request.delete('/api/assets/does-not-exist.png');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ASSET_NOT_FOUND');
    });

    it('DELETE /api/assets/:filename?force=true deletes file and removes from person assets[]', async () => {
        writeTestAsset();

        const createRes = await request.post('/api/people').send({
            names: [{ first: 'Force', last: 'Delete' }],
            sex: 'U',
            assets: [TEST_ASSET],
        });
        expect(createRes.status).toBe(201);
        const personId = createRes.body.id;
        createdPersonIds.add(personId);

        const res = await request.delete(`/api/assets/${TEST_ASSET}?force=true`);
        expect(res.status).toBe(204);
        expect(fs.existsSync(TEST_ASSET_PATH)).toBe(false);

        // Person should no longer reference the deleted asset
        const personRes = await request.get(`/api/people/${personId}`);
        expect(personRes.status).toBe(200);
        expect(personRes.body.assets).not.toContain(TEST_ASSET);
    });

    it('DELETE /api/assets/:filename?force=true still returns 404 for missing file', async () => {
        const res = await request.delete('/api/assets/does-not-exist.png?force=true');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ASSET_NOT_FOUND');
    });

    // ── POST /api/people/:id/assets/link ─────────────────────────────────────

    it('POST /api/people/:id/assets/link links an existing asset', async () => {
        writeTestAsset();

        const createRes = await request.post('/api/people').send({
            names: [{ first: 'Link', last: 'Test' }],
            sex: 'U',
        });
        expect(createRes.status).toBe(201);
        const personId = createRes.body.id;
        createdPersonIds.add(personId);

        const res = await request
            .post(`/api/people/${personId}/assets/link`)
            .send({ filename: TEST_ASSET });

        expect(res.status).toBe(200);
        expect(res.body.assets).toContain(TEST_ASSET);
    });

    it('POST /api/people/:id/assets/link is idempotent', async () => {
        writeTestAsset();

        const createRes = await request.post('/api/people').send({
            names: [{ first: 'Idem', last: 'Potent' }],
            sex: 'U',
            assets: [TEST_ASSET],
        });
        expect(createRes.status).toBe(201);
        const personId = createRes.body.id;
        createdPersonIds.add(personId);

        const res = await request
            .post(`/api/people/${personId}/assets/link`)
            .send({ filename: TEST_ASSET });

        expect(res.status).toBe(200);
        const occurrences = (res.body.assets as string[]).filter(a => a === TEST_ASSET).length;
        expect(occurrences).toBe(1);
    });

    it('POST /api/people/:id/assets/link returns 404 for missing person', async () => {
        const res = await request
            .post('/api/people/N_does-not-exist-1900-xxxxxxxx/assets/link')
            .send({ filename: TEST_ASSET });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('PERSON_NOT_FOUND');
    });

    it('POST /api/people/:id/assets/link returns 400 for missing file on disk', async () => {
        const createRes = await request.post('/api/people').send({
            names: [{ first: 'No', last: 'File' }],
            sex: 'U',
        });
        expect(createRes.status).toBe(201);
        const personId = createRes.body.id;
        createdPersonIds.add(personId);

        const res = await request
            .post(`/api/people/${personId}/assets/link`)
            .send({ filename: 'does-not-exist.png' });

        expect(res.status).toBe(400);
    });

    // ── DELETE /api/people/:id/media/:filename (unlink-only) ─────────────────

    it('DELETE /api/people/:id/media/:filename unlinks asset but does NOT delete file from disk', async () => {
        writeTestAsset();

        const createRes = await request.post('/api/people').send({
            names: [{ first: 'Unlink', last: 'Test' }],
            sex: 'U',
            assets: [TEST_ASSET],
        });
        expect(createRes.status).toBe(201);
        const personId = createRes.body.id;
        createdPersonIds.add(personId);

        const res = await request.delete(`/api/people/${personId}/media/${TEST_ASSET}`);
        expect(res.status).toBe(204);

        // File should still exist on disk
        expect(fs.existsSync(TEST_ASSET_PATH)).toBe(true);

        // Person should no longer reference it
        const personRes = await request.get(`/api/people/${personId}`);
        expect(personRes.status).toBe(200);
        expect(personRes.body.assets).not.toContain(TEST_ASSET);
    });

    // ── GET /api/assets?personIds= ───────────────────────────────────────────

    describe('GET /api/assets with personIds filter', () => {
        it('returns only assets tagged with a specific person', async () => {
            writeTestAsset('test-asset-person-a.png');
            writeTestAsset('test-asset-person-b.png');

            const personARes = await request.post('/api/people').send({
                names: [{ first: 'PersonA', last: 'Filter' }],
                sex: 'U',
                assets: ['test-asset-person-a.png'],
            });
            expect(personARes.status).toBe(201);
            const personAId = personARes.body.id;
            createdPersonIds.add(personAId);

            const personBRes = await request.post('/api/people').send({
                names: [{ first: 'PersonB', last: 'Filter' }],
                sex: 'U',
                assets: ['test-asset-person-b.png'],
            });
            expect(personBRes.status).toBe(201);
            const personBId = personBRes.body.id;
            createdPersonIds.add(personBId);

            const res = await request.get(`/api/assets?personIds=${personAId}`);
            expect(res.status).toBe(200);

            const filenames = res.body.assets.map((a: any) => a.filename);
            expect(filenames).toContain('test-asset-person-a.png');
            expect(filenames).not.toContain('test-asset-person-b.png');
        });

        it('returns only assets tagged with ALL specified people (AND filter)', async () => {
            writeTestAsset('test-asset-shared.png');
            writeTestAsset('test-asset-only-first.png');

            const firstRes = await request.post('/api/people').send({
                names: [{ first: 'AndFirst', last: 'Filter' }],
                sex: 'U',
                assets: ['test-asset-shared.png', 'test-asset-only-first.png'],
            });
            expect(firstRes.status).toBe(201);
            const firstId = firstRes.body.id;
            createdPersonIds.add(firstId);

            const secondRes = await request.post('/api/people').send({
                names: [{ first: 'AndSecond', last: 'Filter' }],
                sex: 'U',
                assets: ['test-asset-shared.png'],
            });
            expect(secondRes.status).toBe(201);
            const secondId = secondRes.body.id;
            createdPersonIds.add(secondId);

            const res = await request.get(`/api/assets?personIds=${firstId},${secondId}`);
            expect(res.status).toBe(200);

            const filenames = res.body.assets.map((a: any) => a.filename);
            expect(filenames).toContain('test-asset-shared.png');
            expect(filenames).not.toContain('test-asset-only-first.png');
        });

        it('personIds filter combines with text search q', async () => {
            writeTestAsset('test-asset-combo-alpha.png');
            writeTestAsset('test-asset-combo-beta.png');

            const personRes = await request.post('/api/people').send({
                names: [{ first: 'ComboFilter', last: 'Person' }],
                sex: 'U',
                assets: ['test-asset-combo-alpha.png', 'test-asset-combo-beta.png'],
            });
            expect(personRes.status).toBe(201);
            const personId = personRes.body.id;
            createdPersonIds.add(personId);

            // q=alpha only matches the alpha file (beta does not contain alpha as substring)
            const res = await request.get(`/api/assets?personIds=${personId}&q=alpha`);
            expect(res.status).toBe(200);

            const filenames = res.body.assets.map((a: any) => a.filename);
            expect(filenames).toContain('test-asset-combo-alpha.png');
            expect(filenames).not.toContain('test-asset-combo-beta.png');
        });
    });

    // ── DELETE /api/people/:id/assets/link/:filename ─────────────────────────

    it('DELETE /api/people/:id/assets/link/:filename unlinks asset from person.assets[]', async () => {
        writeTestAsset();

        const createRes = await request.post('/api/people').send({
            names: [{ first: 'ExplicitUnlink', last: 'Test' }],
            sex: 'U',
            assets: [TEST_ASSET],
        });
        expect(createRes.status).toBe(201);
        const personId = createRes.body.id;
        createdPersonIds.add(personId);

        const res = await request.delete(`/api/people/${personId}/assets/link/${TEST_ASSET}`);
        expect(res.status).toBe(204);

        // File should still exist on disk
        expect(fs.existsSync(TEST_ASSET_PATH)).toBe(true);

        // Person should no longer reference it
        const personRes = await request.get(`/api/people/${personId}`);
        expect(personRes.body.assets).not.toContain(TEST_ASSET);
    });

    it('DELETE /api/people/:id/assets/link/:filename returns 404 for missing person', async () => {
        const res = await request.delete('/api/people/N_no-one-1900-xxxxxxxx/assets/link/some.png');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('PERSON_NOT_FOUND');
    });

    it('DELETE /api/people/:id/assets/link/:filename returns 404 if not linked', async () => {
        const createRes = await request.post('/api/people').send({
            names: [{ first: 'NotLinked', last: 'Test' }],
            sex: 'U',
        });
        expect(createRes.status).toBe(201);
        const personId = createRes.body.id;
        createdPersonIds.add(personId);

        const res = await request.delete(`/api/people/${personId}/assets/link/nonexistent.png`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ASSET_NOT_FOUND');
    });

    // ── Timestamps ──────────────────────────────────────────────────────────

    it('PUT /api/assets/:filename/meta sets created_at and modified_at on first write', async () => {
        writeTestAsset();
        const before = new Date().toISOString();

        const res = await request
            .put(`/api/assets/${TEST_ASSET}/meta`)
            .send({ description: 'timestamp test' });

        const after = new Date().toISOString();
        expect(res.status).toBe(200);
        expect(typeof res.body.created_at).toBe('string');
        expect(typeof res.body.modified_at).toBe('string');
        expect(res.body.created_at >= before).toBe(true);
        expect(res.body.created_at <= after).toBe(true);
        expect(res.body.modified_at).toBe(res.body.created_at);
    });

    it('PUT /api/assets/:filename/meta updates modified_at but preserves created_at on subsequent writes', async () => {
        writeTestAsset();

        const first = await request
            .put(`/api/assets/${TEST_ASSET}/meta`)
            .send({ description: 'first write' });
        expect(first.status).toBe(200);
        const originalCreatedAt = first.body.created_at;
        expect(typeof originalCreatedAt).toBe('string');

        await new Promise(r => setTimeout(r, 15));

        const second = await request
            .put(`/api/assets/${TEST_ASSET}/meta`)
            .send({ description: 'second write' });
        expect(second.status).toBe(200);
        expect(second.body.created_at).toBe(originalCreatedAt);
        expect(second.body.modified_at > originalCreatedAt).toBe(true);
    });

    it('GET /api/assets?sort=created&order=desc returns most recently added first', async () => {
        writeTestAsset('test-asset-ts-first.png');
        await new Promise(r => setTimeout(r, 15));
        writeTestAsset('test-asset-ts-second.png');

        // Write timestamps via meta PUT
        await request.put('/api/assets/test-asset-ts-first.png/meta').send({ description: 'first' });
        await new Promise(r => setTimeout(r, 15));
        await request.put('/api/assets/test-asset-ts-second.png/meta').send({ description: 'second' });

        const res = await request.get('/api/assets?sort=created&order=desc');
        expect(res.status).toBe(200);

        const testAssets = (res.body.assets as any[]).filter(a =>
            a.filename === 'test-asset-ts-first.png' || a.filename === 'test-asset-ts-second.png'
        );
        expect(testAssets.length).toBe(2);
        // second was created last, so it should appear first in desc order
        expect(testAssets[0].filename).toBe('test-asset-ts-second.png');
        expect(testAssets[1].filename).toBe('test-asset-ts-first.png');

        try { fs.unlinkSync(path.join(ASSETS_DIR, 'test-asset-ts-first.png')); } catch { /* ignore */ }
        try { fs.unlinkSync(path.join(ASSETS_DIR, 'test-asset-ts-second.png')); } catch { /* ignore */ }
    });

    it('GET /api/assets?sort=modified returns most recently edited first by default', async () => {
        writeTestAsset('test-asset-mod-a.png');
        writeTestAsset('test-asset-mod-b.png');

        await request.put('/api/assets/test-asset-mod-a.png/meta').send({ description: 'a' });
        await request.put('/api/assets/test-asset-mod-b.png/meta').send({ description: 'b' });
        await new Promise(r => setTimeout(r, 15));
        // Update a — it should now have newest modified_at
        await request.put('/api/assets/test-asset-mod-a.png/meta').send({ description: 'a updated' });

        const res = await request.get('/api/assets?sort=modified&order=desc');
        expect(res.status).toBe(200);

        const testAssets = (res.body.assets as any[]).filter(a =>
            a.filename === 'test-asset-mod-a.png' || a.filename === 'test-asset-mod-b.png'
        );
        expect(testAssets.length).toBe(2);
        expect(testAssets[0].filename).toBe('test-asset-mod-a.png');

        try { fs.unlinkSync(path.join(ASSETS_DIR, 'test-asset-mod-a.png')); } catch { /* ignore */ }
        try { fs.unlinkSync(path.join(ASSETS_DIR, 'test-asset-mod-b.png')); } catch { /* ignore */ }
    });

    it('GET /api/assets assets without created_at sort last for sort=created desc', async () => {
        // Write an asset WITHOUT going through meta PUT (no timestamps)
        writeTestAsset('test-asset-no-ts.png');
        // Write an asset WITH timestamps via meta PUT
        writeTestAsset('test-asset-with-ts.png');
        await request.put('/api/assets/test-asset-with-ts.png/meta').send({ description: 'has ts' });

        const res = await request.get('/api/assets?sort=created&order=desc');
        expect(res.status).toBe(200);

        const testAssets = (res.body.assets as any[]).filter(a =>
            a.filename === 'test-asset-no-ts.png' || a.filename === 'test-asset-with-ts.png'
        );
        expect(testAssets.length).toBe(2);
        // with-ts should appear before no-ts (nulls last)
        expect(testAssets[0].filename).toBe('test-asset-with-ts.png');
        expect(testAssets[1].filename).toBe('test-asset-no-ts.png');

        try { fs.unlinkSync(path.join(ASSETS_DIR, 'test-asset-no-ts.png')); } catch { /* ignore */ }
        try { fs.unlinkSync(path.join(ASSETS_DIR, 'test-asset-with-ts.png')); } catch { /* ignore */ }
    });

    it('GET /api/assets response includes created_at and modified_at in metadata', async () => {
        writeTestAsset();
        await request.put(`/api/assets/${TEST_ASSET}/meta`).send({ description: 'include ts' });

        const res = await request.get('/api/assets');
        expect(res.status).toBe(200);
        const item = res.body.assets.find((a: any) => a.filename === TEST_ASSET);
        expect(item).toBeDefined();
        expect(typeof item.metadata.created_at).toBe('string');
        expect(typeof item.metadata.modified_at).toBe('string');
    });

    // ── POST /api/assets/upload ──────────────────────────────────────────────

    describe('POST /api/assets/upload', () => {
        const PNG_BUF = Buffer.from(
            '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000020001e221bc330000000049454e44ae426082',
            'hex'
        );

        it('single PNG → 200, filename in uploaded[], file on disk, assets.yaml seeded', async () => {
            const res = await request
                .post('/api/assets/upload')
                .attach('files', PNG_BUF, { filename: 'test-asset-upload-single.png', contentType: 'image/png' });

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.uploaded)).toBe(true);
            expect(res.body.uploaded.length).toBe(1);
            const { filename, originalName } = res.body.uploaded[0];
            expect(typeof filename).toBe('string');
            expect(originalName).toBe('test-asset-upload-single.png');
            expect(fs.existsSync(path.join(ASSETS_DIR, filename))).toBe(true);
            expect(fs.existsSync(path.join(META_DIR, 'assets.yaml'))).toBe(true);
        });

        it('3 files → all 3 in uploaded[]', async () => {
            const res = await request
                .post('/api/assets/upload')
                .attach('files', PNG_BUF, { filename: 'test-asset-upload-a.png', contentType: 'image/png' })
                .attach('files', PNG_BUF, { filename: 'test-asset-upload-b.png', contentType: 'image/png' })
                .attach('files', PNG_BUF, { filename: 'test-asset-upload-c.png', contentType: 'image/png' });

            expect(res.status).toBe(200);
            expect(res.body.uploaded.length).toBe(3);
            const names = (res.body.uploaded as any[]).map((u) => u.originalName);
            expect(names).toContain('test-asset-upload-a.png');
            expect(names).toContain('test-asset-upload-b.png');
            expect(names).toContain('test-asset-upload-c.png');
        });

        it('filename collision → second upload gets -1 suffix', async () => {
            writeTestAsset('test-asset-upload-collision.png');

            const res = await request
                .post('/api/assets/upload')
                .attach('files', PNG_BUF, { filename: 'test-asset-upload-collision.png', contentType: 'image/png' });

            expect(res.status).toBe(200);
            expect(res.body.uploaded.length).toBe(1);
            expect(res.body.uploaded[0].filename).toBe('test-asset-upload-collision-1.png');
        });

        it('disallowed MIME (.exe) + valid PNG → .exe in rejected[], PNG in uploaded[], HTTP 200', async () => {
            const res = await request
                .post('/api/assets/upload')
                .attach('files', Buffer.from('MZ'), { filename: 'test-asset-upload-bad.exe', contentType: 'application/octet-stream' })
                .attach('files', PNG_BUF, { filename: 'test-asset-upload-good.png', contentType: 'image/png' });

            expect(res.status).toBe(200);
            const rejectedNames = (res.body.rejected as any[]).map((r) => r.originalName);
            const uploadedNames = (res.body.uploaded as any[]).map((u) => u.originalName);
            expect(rejectedNames).toContain('test-asset-upload-bad.exe');
            expect(uploadedNames).toContain('test-asset-upload-good.png');
        });

        it('empty body → 400 VALIDATION_ERROR', async () => {
            const res = await request.post('/api/assets/upload');
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('VALIDATION_ERROR');
        });

        it('two files → both appear in assets.yaml with created_at set', async () => {
            const res = await request
                .post('/api/assets/upload')
                .attach('files', PNG_BUF, { filename: 'test-asset-upload-ts1.png', contentType: 'image/png' })
                .attach('files', PNG_BUF, { filename: 'test-asset-upload-ts2.png', contentType: 'image/png' });

            expect(res.status).toBe(200);
            expect(res.body.uploaded.length).toBe(2);

            const listRes = await request.get('/api/assets');
            expect(listRes.status).toBe(200);
            for (const { filename } of res.body.uploaded as Array<{ filename: string; originalName: string }>) {
                const item = (listRes.body.assets as any[]).find((a) => a.filename === filename);
                expect(item).toBeDefined();
                expect(typeof item.metadata.created_at).toBe('string');
            }
        });
    });

    // ── PUT /api/people/:id/events/:eventId/media ────────────────────────────

    describe('PUT /api/people/:id/events/:eventId/media', () => {
        const PNG_BUF = Buffer.from(
            '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000020001e221bc330000000049454e44ae426082',
            'hex'
        );
        const TEST_EVENT_ID = 'test-event-id-upload';

        it('links uploaded file to person.assets[] in addition to event.assets[]', async () => {
            const createRes = await request.post('/api/people').send({
                names: [{ first: 'EventUpload', last: 'Test' }],
                sex: 'U',
                events: [{ type: 'birth', id: TEST_EVENT_ID }],
            });
            expect(createRes.status).toBe(201);
            const personId = createRes.body.id;
            createdPersonIds.add(personId);

            const uploadRes = await request
                .put(`/api/people/${personId}/events/${TEST_EVENT_ID}/media`)
                .attach('file', PNG_BUF, { filename: 'test-asset-event-upload.png', contentType: 'image/png' });

            expect(uploadRes.status).toBe(200);
            const { filename } = uploadRes.body;
            expect(typeof filename).toBe('string');

            // File should appear in person.assets[]
            const personRes = await request.get(`/api/people/${personId}`);
            expect(personRes.status).toBe(200);
            expect(personRes.body.assets).toContain(filename);

            // File should also be in the event.assets[]
            const event = (personRes.body.events as any[]).find((e: any) => e.id === TEST_EVENT_ID);
            expect(event).toBeDefined();
            expect(event.assets).toContain(filename);
        });

        it('does not duplicate person.assets[] on second upload to same event', async () => {
            const createRes = await request.post('/api/people').send({
                names: [{ first: 'EventDupeCheck', last: 'Test' }],
                sex: 'U',
                events: [{ type: 'birth', id: TEST_EVENT_ID }],
            });
            expect(createRes.status).toBe(201);
            const personId = createRes.body.id;
            createdPersonIds.add(personId);

            const up1 = await request
                .put(`/api/people/${personId}/events/${TEST_EVENT_ID}/media`)
                .attach('file', PNG_BUF, { filename: 'test-asset-event-dupe1.png', contentType: 'image/png' });
            const up2 = await request
                .put(`/api/people/${personId}/events/${TEST_EVENT_ID}/media`)
                .attach('file', PNG_BUF, { filename: 'test-asset-event-dupe2.png', contentType: 'image/png' });

            expect(up1.status).toBe(200);
            expect(up2.status).toBe(200);

            const personRes = await request.get(`/api/people/${personId}`);
            const assets: string[] = personRes.body.assets;
            // Each filename should appear exactly once in person.assets[]
            const count1 = assets.filter(a => a === up1.body.filename).length;
            const count2 = assets.filter(a => a === up2.body.filename).length;
            expect(count1).toBe(1);
            expect(count2).toBe(1);
        });
    });

    // ── DELETE /api/assets/:filename?force=true cleans event.assets[] ───────

    describe('DELETE /api/assets/:filename?force=true event cleanup', () => {
        it('removes filename from event.assets[] when force-deleting', async () => {
            writeTestAsset();

            const createRes = await request.post('/api/people').send({
                names: [{ first: 'EventForce', last: 'Delete' }],
                sex: 'U',
                events: [{ type: 'census', id: 'test-event-force-del', assets: [TEST_ASSET] }],
            });
            expect(createRes.status).toBe(201);
            const personId = createRes.body.id;
            createdPersonIds.add(personId);

            // Verify the event has the asset
            const before = await request.get(`/api/people/${personId}`);
            const eventBefore = (before.body.events as any[]).find((e: any) => e.id === 'test-event-force-del');
            expect(eventBefore?.assets).toContain(TEST_ASSET);

            // Force-delete the asset
            const delRes = await request.delete(`/api/assets/${TEST_ASSET}?force=true`);
            expect(delRes.status).toBe(204);
            expect(fs.existsSync(TEST_ASSET_PATH)).toBe(false);

            // Event should no longer reference the asset
            const after = await request.get(`/api/people/${personId}`);
            expect(after.status).toBe(200);
            const eventAfter = (after.body.events as any[]).find((e: any) => e.id === 'test-event-force-del');
            expect(eventAfter?.assets).not.toContain(TEST_ASSET);
        });

        it('returns 409 (not 200) when asset is only in event.assets[] and force is false', async () => {
            writeTestAsset();

            const createRes = await request.post('/api/people').send({
                names: [{ first: 'EventNoForce', last: 'Delete' }],
                sex: 'U',
                events: [{ type: 'census', id: 'test-event-no-force', assets: [TEST_ASSET] }],
            });
            expect(createRes.status).toBe(201);
            const personId = createRes.body.id;
            createdPersonIds.add(personId);

            const delRes = await request.delete(`/api/assets/${TEST_ASSET}`);
            expect(delRes.status).toBe(409);
            expect(delRes.body.code).toBe('ASSET_REFERENCED');
            expect(fs.existsSync(TEST_ASSET_PATH)).toBe(true);
        });
    });
});
