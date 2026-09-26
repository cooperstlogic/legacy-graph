import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server';
import supertest from 'supertest';
import gitLib from 'isomorphic-git';
import * as fs from 'fs';
import * as nodeFs from 'fs';
import * as path from 'path';
import bcrypt from 'bcryptjs';
import yaml from 'js-yaml';
import jwt from 'jsonwebtoken';

describe('Authentication', () => {
    let server: FastifyInstance;
    let request: ReturnType<typeof supertest>;
    // Use an isolated data directory to avoid race conditions with Server.test.ts
    const testDataDir = './tests/fixtures/auth-data';
    const metaDir = path.join(testDataDir, '_meta');
    const peopleDir = path.join(testDataDir, 'people');
    const authFilePath = path.join(metaDir, 'auth.yaml');

    // Test credentials
    const TEST_USER = 'admin';
    const TEST_PASSWORD = 'securepassword123';
    const JWT_SECRET = 'test-jwt-secret-key-that-is-at-least-32-characters-long';

    beforeEach(async () => {
        // Create isolated data directory structure
        fs.mkdirSync(peopleDir, { recursive: true });
        fs.mkdirSync(metaDir, { recursive: true });

        // Ensure git repo exists
        const gitDir = path.join(testDataDir, '.git');
        if (!fs.existsSync(gitDir)) {
            await gitLib.init({ fs: nodeFs, dir: testDataDir });
            await gitLib.setConfig({ fs: nodeFs, dir: testDataDir, path: 'user.name', value: 'Test User' });
            await gitLib.setConfig({ fs: nodeFs, dir: testDataDir, path: 'user.email', value: 'test@example.com' });
            const gitignorePath = path.join(testDataDir, '.gitignore');
            fs.writeFileSync(gitignorePath, '# Test git repo\n');
            await gitLib.add({ fs: nodeFs, dir: testDataDir, filepath: '.gitignore' });
            await gitLib.commit({
                fs: nodeFs,
                dir: testDataDir,
                message: 'Initial commit',
                author: { name: 'Test User', email: 'test@example.com' }
            });
        }

        // Create /_meta/auth.yaml with test credentials
        const passwordHash = bcrypt.hashSync(TEST_PASSWORD, 10);
        const authConfig = {
            jwt_secret: JWT_SECRET,
            session_expiry: '24h',
            users: [
                { username: TEST_USER, password_hash: passwordHash }
            ]
        };
        fs.writeFileSync(authFilePath, yaml.dump(authConfig));

        // Create server with auth enabled
        server = await createServer({
            logger: false,
            dataDir: testDataDir
        });

        await server.listen({ port: 0 });
        const address = server.server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 3000;
        request = supertest(`http://localhost:${port}`);
    });

    afterEach(async () => {
        await server.close();
        // Clean up auth file
        if (fs.existsSync(authFilePath)) {
            fs.unlinkSync(authFilePath);
        }
    });

    describe('POST /api/auth/login', () => {
        it('should return JWT in HttpOnly cookie with valid credentials', async () => {
            const response = await request
                .post('/api/auth/login')
                .send({ username: TEST_USER, password: TEST_PASSWORD });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('message', 'Login successful');
            expect(response.body).toHaveProperty('username', TEST_USER);

            // Check for HttpOnly cookie
            const cookies = response.headers['set-cookie'];
            expect(cookies).toBeDefined();
            const tokenCookie = Array.isArray(cookies)
                ? cookies.find((c: string) => c.startsWith('token='))
                : cookies?.startsWith('token=') ? cookies : undefined;
            expect(tokenCookie).toBeDefined();
            expect(tokenCookie).toContain('HttpOnly');
        });

        it('should return 401 with invalid password', async () => {
            const response = await request
                .post('/api/auth/login')
                .send({ username: TEST_USER, password: 'wrongpassword' });

            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty('error');
            expect(response.body).toHaveProperty('code', 'INVALID_CREDENTIALS');
        });

        it('should return 401 with non-existent username', async () => {
            const response = await request
                .post('/api/auth/login')
                .send({ username: 'nonexistent', password: TEST_PASSWORD });

            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty('code', 'INVALID_CREDENTIALS');
        });

        it('should return 400 with missing credentials', async () => {
            const response = await request
                .post('/api/auth/login')
                .send({});

            expect(response.status).toBe(400);
            expect(response.body).toHaveProperty('code', 'MISSING_CREDENTIALS');
        });

        it('should return 429 after 10 attempts from one IP within a minute', async () => {
            for (let i = 0; i < 10; i++) {
                const attempt = await request
                    .post('/api/auth/login')
                    .send({ username: TEST_USER, password: 'wrongpassword' });
                expect(attempt.status).toBe(401);
            }

            // Even the correct password is refused once the limit is hit
            const response = await request
                .post('/api/auth/login')
                .send({ username: TEST_USER, password: TEST_PASSWORD });

            expect(response.status).toBe(429);
            expect(response.body).toHaveProperty('code', 'RATE_LIMITED');
            expect(response.headers['set-cookie']).toBeUndefined();
        });
    });

    describe('POST /api/auth/logout', () => {
        it('should clear the auth cookie', async () => {
            // First login to get a cookie
            const loginResponse = await request
                .post('/api/auth/login')
                .send({ username: TEST_USER, password: TEST_PASSWORD });

            const cookies = loginResponse.headers['set-cookie'];
            const tokenCookie = Array.isArray(cookies)
                ? cookies.find((c: string) => c.startsWith('token='))
                : cookies;

            // Now logout
            const logoutResponse = await request
                .post('/api/auth/logout')
                .set('Cookie', tokenCookie!);

            expect(logoutResponse.status).toBe(200);
            expect(logoutResponse.body).toHaveProperty('message', 'Logout successful');

            // Verify cookie is cleared (set to empty with past expiry)
            const logoutCookies = logoutResponse.headers['set-cookie'];
            const clearedCookie = Array.isArray(logoutCookies)
                ? logoutCookies.find((c: string) => c.startsWith('token='))
                : logoutCookies;
            expect(clearedCookie).toBeDefined();
            // Cookie should be cleared (empty value or expired)
            expect(clearedCookie).toMatch(/token=;|token=$/);
        });
    });

    describe('Auth Guard', () => {
        it('should allow GET /api/system/status without auth', async () => {
            const response = await request.get('/api/system/status');
            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('nodeCount');
        });

        it('should allow POST /api/auth/login without auth', async () => {
            const response = await request
                .post('/api/auth/login')
                .send({ username: TEST_USER, password: TEST_PASSWORD });
            // Should not be 401 — login route is public
            expect(response.status).toBe(200);
        });

        it('should reject unauthenticated requests to protected endpoints', async () => {
            const response = await request.get('/api/search?q=test');
            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty('code', 'UNAUTHORIZED');
        });

        it('should grant access with valid JWT cookie', async () => {
            // Login first
            const loginResponse = await request
                .post('/api/auth/login')
                .send({ username: TEST_USER, password: TEST_PASSWORD });

            const cookies = loginResponse.headers['set-cookie'];
            const tokenCookie = Array.isArray(cookies)
                ? cookies.find((c: string) => c.startsWith('token='))
                : cookies;

            // Access protected endpoint with cookie
            const response = await request
                .get('/api/search')
                .query({ q: 'test' })
                .set('Cookie', tokenCookie!);

            expect(response.status).not.toBe(401);
            // Should be 200 (successful search)
            expect(response.status).toBe(200);
        });

        it('should reject requests with invalid/tampered JWT', async () => {
            const response = await request
                .get('/api/search?q=test')
                .set('Cookie', 'token=invalid.jwt.token');

            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty('code', 'INVALID_TOKEN');
        });

        it('should reject requests with expired JWT', async () => {
            // Create a JWT that is already expired using jsonwebtoken directly
            const expiredToken = jwt.sign(
                { username: TEST_USER },
                JWT_SECRET,
                { expiresIn: '-1s' } // Already expired
            );

            const response = await request
                .get('/api/search?q=test')
                .set('Cookie', `token=${expiredToken}`);

            expect(response.status).toBe(401);
            expect(response.body).toHaveProperty('code', 'INVALID_TOKEN');
        });
    });
});
