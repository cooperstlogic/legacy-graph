// tests/api/PathTraversal.test.ts
//
// Route params are URL-decoded by Fastify, so `..%2F` arrives as `../`. Asset
// names stored in person/story data are client-controlled too. None of these
// may reach the file system outside the data directory.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const CANARY_STORY = '---\ntitle: Canary\n---\nsecret story body\n';
const CANARY_ASSET = 'secret asset body';

// From <data>/stories or <data>/assets, `../../` lands in the directory above <data>.
const STORY_ESCAPE = encodeURIComponent('../../canary');
const ASSET_ESCAPE_RAW = '../../canary.txt';
const ASSET_ESCAPE = encodeURIComponent(ASSET_ESCAPE_RAW);

describe('Path traversal guards', () => {
    let server: FastifyInstance;
    let root: string;
    let dataDir: string;
    let canaryStory: string;
    let canaryAsset: string;

    async function createStory(body: Record<string, unknown> = {}): Promise<string> {
        const res = await server.inject({ method: 'POST', url: '/api/stories', payload: { title: 'Traversal probe', ...body } });
        expect(res.statusCode).toBe(201);
        return res.json().id;
    }

    async function createPerson(body: Record<string, unknown> = {}): Promise<string> {
        const res = await server.inject({
            method: 'POST', url: '/api/people',
            payload: { names: [{ first: 'Traversal', last: 'Probe' }], sex: 'U', ...body },
        });
        expect(res.statusCode).toBe(201);
        return res.json().id;
    }

    async function expectCanariesIntact() {
        expect(await fs.readFile(canaryStory, 'utf8')).toBe(CANARY_STORY);
        expect(await fs.readFile(canaryAsset, 'utf8')).toBe(CANARY_ASSET);
    }

    // Fresh data dir and server per test: a reference left by one test (e.g. a
    // person linking the canary) must not mask a missing guard in another.
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'path-traversal-test-'));
        dataDir = path.join(root, 'data');
        canaryStory = path.join(root, 'canary.md');
        canaryAsset = path.join(root, 'canary.txt');
        for (const dir of ['people', 'stories', 'assets', '_meta']) {
            await fs.mkdir(path.join(dataDir, dir), { recursive: true });
        }
        await fs.writeFile(canaryStory, CANARY_STORY, 'utf8');
        await fs.writeFile(canaryAsset, CANARY_ASSET, 'utf8');
        server = await createServer({ logger: false, dataDir });
    });

    afterEach(async () => {
        await server.close();
        await fs.rm(root, { recursive: true, force: true });
    });

    // ── Stories ────────────────────────────────────────────────────────────

    it('GET /api/stories/:id does not read files outside stories/', async () => {
        const res = await server.inject({ method: 'GET', url: `/api/stories/${STORY_ESCAPE}` });
        expect(res.statusCode).toBe(404);
        expect(res.body).not.toContain('secret story body');
    });

    it('PUT /api/stories/:id does not overwrite files outside stories/', async () => {
        const res = await server.inject({ method: 'PUT', url: `/api/stories/${STORY_ESCAPE}`, payload: { title: 'Pwned' } });
        expect(res.statusCode).toBe(404);
        await expectCanariesIntact();
    });

    it('DELETE /api/stories/:id does not delete files outside stories/', async () => {
        const res = await server.inject({ method: 'DELETE', url: `/api/stories/${STORY_ESCAPE}` });
        expect(res.statusCode).toBe(404);
        await expectCanariesIntact();
    });

    it('PUT /api/stories/:id/media rejects a traversal id', async () => {
        const res = await server.inject({ method: 'PUT', url: `/api/stories/${STORY_ESCAPE}/media` });
        expect(res.statusCode).toBe(404);
        await expectCanariesIntact();
    });

    it('DELETE /api/stories/:id/media/:filename does not delete files outside assets/', async () => {
        const id = await createStory();
        const res = await server.inject({ method: 'DELETE', url: `/api/stories/${id}/media/${ASSET_ESCAPE}` });
        expect(res.statusCode).toBe(404);
        await expectCanariesIntact();
    });

    it('deleting a story does not unlink traversal paths listed in its assets', async () => {
        const id = await createStory({ assets: [ASSET_ESCAPE_RAW] });
        const res = await server.inject({ method: 'DELETE', url: `/api/stories/${id}` });
        expect(res.statusCode).toBe(204);
        await expectCanariesIntact();
    });

    // ── Assets ─────────────────────────────────────────────────────────────

    it('PUT /api/assets/:filename/meta rejects a traversal filename', async () => {
        const res = await server.inject({ method: 'PUT', url: `/api/assets/${ASSET_ESCAPE}/meta`, payload: { name: 'x' } });
        expect(res.statusCode).toBe(404);
    });

    it('DELETE /api/assets/:filename does not delete files outside assets/', async () => {
        const res = await server.inject({ method: 'DELETE', url: `/api/assets/${ASSET_ESCAPE}?force=true` });
        expect(res.statusCode).toBe(404);
        await expectCanariesIntact();
    });

    it('POST /api/people/:id/assets/link rejects a traversal filename', async () => {
        const id = await createPerson();
        const res = await server.inject({ method: 'POST', url: `/api/people/${id}/assets/link`, payload: { filename: ASSET_ESCAPE_RAW } });
        expect(res.statusCode).toBe(400);
    });

    // ── People ─────────────────────────────────────────────────────────────

    it('DELETE /api/people/:id/media/:filename?permanent=true does not delete files outside assets/', async () => {
        const id = await createPerson({ assets: [ASSET_ESCAPE_RAW] });
        await server.inject({ method: 'DELETE', url: `/api/people/${id}/media/${ASSET_ESCAPE}?permanent=true` });
        await expectCanariesIntact();
    });
});
