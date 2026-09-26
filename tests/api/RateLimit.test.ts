// tests/api/RateLimit.test.ts
//
// Shared (multi-user) deployments: every API route is rate-limited, keyed by the
// authenticated username when there is one and by client IP otherwise.
import { describe, it, expect, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer, type ServerConfig } from '../../src/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import bcrypt from 'bcryptjs';
import yaml from 'js-yaml';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'rate-limit-test-secret-at-least-32-characters';
const MAX = 5;

describe('API rate limiting', () => {
    let server: FastifyInstance | undefined;
    let dataDir: string | undefined;

    async function start(options: { auth?: boolean } & Partial<ServerConfig> = {}) {
        const { auth, ...config } = options;
        dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rate-limit-test-'));
        for (const dir of ['people', 'stories', 'assets', '_meta']) {
            await fs.mkdir(path.join(dataDir, dir), { recursive: true });
        }
        await fs.writeFile(path.join(dataDir, 'assets', 'photo.txt'), 'x');
        if (auth) {
            const hash = bcrypt.hashSync('pw', 4);
            await fs.writeFile(path.join(dataDir, '_meta', 'auth.yaml'), yaml.dump({
                jwt_secret: JWT_SECRET,
                users: [{ username: 'alice', password_hash: hash }, { username: 'bob', password_hash: hash }],
            }));
        }
        server = await createServer({ logger: false, dataDir, rateLimit: { max: MAX, timeWindow: '1 minute' }, ...config });
        return server;
    }

    function cookieFor(username: string) {
        return { token: jwt.sign({ username }, JWT_SECRET) };
    }

    afterEach(async () => {
        await server?.close();
        if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
        server = undefined;
        dataDir = undefined;
    });

    it('returns 429 RATE_LIMITED once a client exceeds the per-window limit', async () => {
        const s = await start();
        for (let i = 0; i < MAX; i++) {
            expect((await s.inject({ method: 'GET', url: '/api/people' })).statusCode).toBe(200);
        }
        const res = await s.inject({ method: 'GET', url: '/api/people' });
        expect(res.statusCode).toBe(429);
        expect(res.json()).toHaveProperty('code', 'RATE_LIMITED');
    });

    it('does not limit static asset delivery (thumbnail grids fetch many at once)', async () => {
        const s = await start();
        for (let i = 0; i < MAX * 3; i++) {
            expect((await s.inject({ method: 'GET', url: '/assets/photo.txt' })).statusCode).toBe(200);
        }
    });

    it('keys authenticated requests by username, so users behind one IP do not share a bucket', async () => {
        const s = await start({ auth: true });
        for (let i = 0; i < MAX; i++) {
            await s.inject({ method: 'GET', url: '/api/people', cookies: cookieFor('alice') });
        }
        expect((await s.inject({ method: 'GET', url: '/api/people', cookies: cookieFor('alice') })).statusCode).toBe(429);
        expect((await s.inject({ method: 'GET', url: '/api/people', cookies: cookieFor('bob') })).statusCode).toBe(200);
    });

    it('with trustProxy, keys anonymous clients by their forwarded IP rather than the proxy', async () => {
        const s = await start({ trustProxy: true });
        const from = (ip: string) => ({ method: 'GET' as const, url: '/api/people', headers: { 'x-forwarded-for': ip } });
        for (let i = 0; i < MAX; i++) await s.inject(from('203.0.113.1'));
        expect((await s.inject(from('203.0.113.1'))).statusCode).toBe(429);
        expect((await s.inject(from('203.0.113.2'))).statusCode).toBe(200);
    });

    it('login keeps its own stricter limit per client IP', async () => {
        const s = await start({ auth: true, trustProxy: true });
        const login = (ip: string) => s.inject({
            method: 'POST', url: '/api/auth/login',
            headers: { 'x-forwarded-for': ip },
            payload: { username: 'alice', password: 'wrong' },
        });
        for (let i = 0; i < 10; i++) expect((await login('203.0.113.1')).statusCode).toBe(401);
        expect((await login('203.0.113.1')).statusCode).toBe(429);
        // One attacker must not lock everyone else out of logging in
        expect((await login('203.0.113.2')).statusCode).toBe(401);
    });
});
