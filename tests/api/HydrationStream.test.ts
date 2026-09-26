import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server';
import supertest from 'supertest';
import git from 'isomorphic-git';
import bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as nodeFs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SSE Hydration Stream (Phase 3.8.3)', () => {
    let server: FastifyInstance;
    let request: ReturnType<typeof supertest>;
    const testDataDir = './tests/fixtures/data';
    let authDataDir: string | undefined;

    beforeEach(async () => {
        const gitDir = path.join(testDataDir, '.git');
        if (!fs.existsSync(gitDir)) {
            await git.init({ fs: nodeFs, dir: testDataDir });
            await git.setConfig({ fs: nodeFs, dir: testDataDir, path: 'user.name', value: 'Test User' });
            await git.setConfig({ fs: nodeFs, dir: testDataDir, path: 'user.email', value: 'test@example.com' });
            const gitignorePath = path.join(testDataDir, '.gitignore');
            fs.writeFileSync(gitignorePath, '# Test git repo\n');
            await git.add({ fs: nodeFs, dir: testDataDir, filepath: '.gitignore' });
            await git.commit({
                fs: nodeFs,
                dir: testDataDir,
                message: 'Initial commit',
                author: { name: 'Test User', email: 'test@example.com' }
            });
        }

        const authPath = path.join(testDataDir, '_meta', 'auth.yaml');
        if (fs.existsSync(authPath)) fs.unlinkSync(authPath);
    });

    afterEach(async () => {
        if (server) await server.close();
        if (authDataDir) fs.rmSync(authDataDir, { recursive: true, force: true });
        authDataDir = undefined;
    });

    it('should return content-type text/event-stream', async () => {
        server = await createServer({ logger: false, dataDir: testDataDir });
        await server.listen({ port: 0 });
        const address = server.server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 3000;
        request = supertest(`http://localhost:${port}`);

        const response = await request.get('/api/system/hydration/stream');
        expect(response.headers['content-type']).toContain('text/event-stream');
    });

    it('should send complete event immediately when already hydrated', async () => {
        server = await createServer({ logger: false, dataDir: testDataDir });
        await server.listen({ port: 0 });
        const address = server.server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 3000;
        request = supertest(`http://localhost:${port}`);

        const response = await request.get('/api/system/hydration/stream');
        expect(response.status).toBe(200);

        const text = response.text;
        expect(text).toContain('event: complete');
        expect(text).toContain('"nodeCount"');
        expect(text).toContain('"edgeCount"');
        expect(text).toContain('"elapsedMs"');
    });

    it('should be exempt from 503 loading gate', async () => {
        server = await createServer({
            logger: false,
            dataDir: testDataDir,
            awaitHydration: false
        });
        await server.listen({ port: 0 });
        const address = server.server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 3000;
        request = supertest(`http://localhost:${port}`);

        // Give a tiny bit of time for server to start but hydration may still be loading
        const response = await request.get('/api/system/hydration/stream');
        // Should NOT return 503 regardless of hydration state
        expect(response.status).not.toBe(503);
    });

    it('should be exempt from auth guard', async () => {
        // Own data dir: writing auth.yaml into the shared tests/fixtures/data would turn
        // auth on for any server that Server/Assets/Stories tests boot in parallel (401s).
        authDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydration-auth-test-'));
        const authDir = path.join(authDataDir, '_meta');
        fs.mkdirSync(authDir, { recursive: true });
        fs.mkdirSync(path.join(authDataDir, 'people'), { recursive: true });
        const hash = bcrypt.hashSync('password123', 10);
        const authYaml = `jwt_secret: "test-secret-key-that-is-at-least-32-chars-long"
session_expiry: "24h"
users:
  - username: admin
    password_hash: "${hash}"`;
        fs.writeFileSync(path.join(authDir, 'auth.yaml'), authYaml);

        server = await createServer({ logger: false, dataDir: authDataDir });
        await server.listen({ port: 0 });
        const address = server.server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 3000;
        request = supertest(`http://localhost:${port}`);

        // Should succeed without auth token
        const response = await request.get('/api/system/hydration/stream');
        expect(response.status).not.toBe(401);
    });
});
