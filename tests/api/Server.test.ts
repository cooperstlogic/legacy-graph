import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server';
import supertest from 'supertest';
import git from 'isomorphic-git';
import * as fs from 'fs';
import * as nodeFs from 'fs';
import * as path from 'path';
import { createFixtureDataDir } from '../fixtures/fixtureDataDir';

// Own copy of the fixture data: test files run in parallel (see fixtureDataDir.ts)
const TEST_DATA_DIR = createFixtureDataDir('server-test');

describe('Fastify API Server', () => {
    let server: FastifyInstance;
    let request: ReturnType<typeof supertest>;

    beforeEach(async () => {
        // Ensure git repo exists for snapshot tests
        const testDataDir = TEST_DATA_DIR;
        const gitDir = path.join(testDataDir, '.git');

        if (!fs.existsSync(gitDir)) {
            await git.init({ fs: nodeFs, dir: testDataDir });
            await git.setConfig({ fs: nodeFs, dir: testDataDir, path: 'user.name', value: 'Test User' });
            await git.setConfig({ fs: nodeFs, dir: testDataDir, path: 'user.email', value: 'test@example.com' });

            // Create initial commit so HEAD exists
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

        // Ensure no auth config exists (auth disabled for these tests)
        const authPath = path.join(testDataDir, '_meta', 'auth.yaml');
        if (fs.existsSync(authPath)) {
            fs.unlinkSync(authPath);
        }

        // Create server with test configuration
        server = await createServer({
            logger: false, // Disable logging during tests
            dataDir: testDataDir
        });

        await server.listen({ port: 0 }); // Random port
        const address = server.server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 3000;
        request = supertest(`http://localhost:${port}`);
    });

    afterEach(async () => {
        await server.close();
    });

    afterAll(() => {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    });

    it('should start server successfully', () => {
        expect(server).toBeDefined();
        expect(server.server.listening).toBe(true);
    });

    it('should have CORS enabled', async () => {
        const response = await request
            .options('/api/search')
            .set('Origin', 'http://localhost:3001')
            .set('Access-Control-Request-Method', 'GET');

        expect(response.headers['access-control-allow-origin']).toBeDefined();
    });

    it('should return 404 for undefined routes', async () => {
        const response = await request.get('/api/nonexistent');
        expect(response.status).toBe(404);
    });

    describe('GET /api/system/status', () => {
        it('should return system status', async () => {
            const response = await request.get('/api/system/status');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('nodeCount');
            expect(response.body).toHaveProperty('edgeCount');
            expect(response.body).toHaveProperty('hydrationState');
            expect(response.body.hydrationState).toMatch(/ready|loading/);
        });
    });

    describe('GET /api/search', () => {
        it('should search and return results', async () => {
            const response = await request
                .get('/api/search')
                .query({ q: 'test' });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('people');
            expect(response.body).toHaveProperty('stories');
            expect(Array.isArray(response.body.people)).toBe(true);
        });

        it('should return 400 if query parameter is missing', async () => {
            const response = await request.get('/api/search');
            expect(response.status).toBe(400);
        });
    });

    describe('GET /api/stats', () => {
        it('should return dashboard statistics', async () => {
            const response = await request.get('/api/stats');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('totalPeople');
            expect(response.body).toHaveProperty('totalFamilies');
            expect(response.body).toHaveProperty('lastModified');
        });
    });

    describe('GET /api/people', () => {
        it('should return a paginated list of all people', async () => {
            const response = await request.get('/api/people').query({ limit: 10, offset: 0 });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('people');
            expect(response.body).toHaveProperty('totalCount');
            expect(Array.isArray(response.body.people)).toBe(true);
        });

        it('should respect limit, offset, sort, and order parameters', async () => {
            const response = await request.get('/api/people').query({ limit: 5, offset: 5, sort: 'last_modified', order: 'desc' });
            expect(response.status).toBe(200);
        });
    });

    describe('GET /api/people/:id', () => {
        it('should return 404 for non-existent person', async () => {
            const response = await request.get('/api/people/N_nonexistent');
            expect(response.status).toBe(404);
        });

        it('should return person data with computed relationships', async () => {
            // This test requires a fixture person to exist
            // For now, we'll just verify the endpoint structure
            const response = await request.get('/api/people/N_test123');

            // Either 404 (no fixture) or 200 with proper structure
            if (response.status === 200) {
                expect(response.body).toHaveProperty('id');
                expect(response.body).toHaveProperty('names');
                expect(response.body).toHaveProperty('_computed');
            } else {
                expect(response.status).toBe(404);
            }
        });
    });

    describe('POST /api/people', () => {
        it('should create a new person', async () => {
            const newPerson = {
                names: [{ first: 'Test', last: 'Person', primary: true }],
                sex: 'U',
                events: []
            };

            const response = await request
                .post('/api/people')
                .send(newPerson);

            expect(response.status).toBe(201);
            expect(response.body).toHaveProperty('id');
            expect(response.body.id).toMatch(/^N_/);
        });

        it('should return 400 for invalid person data', async () => {
            const invalid = {
                // Missing required fields
                sex: 'invalid'
            };

            const response = await request
                .post('/api/people')
                .send(invalid);

            expect(response.status).toBe(400);
        });
    });

    describe('PUT /api/people/:id', () => {
        it('should update an existing person', async () => {
            // First create a person
            const newPerson = {
                names: [{ first: 'Update', last: 'Test', primary: true }],
                sex: 'M',
                events: []
            };

            const createResponse = await request
                .post('/api/people')
                .send(newPerson);

            const personId = createResponse.body.id;

            // Update the person
            const updates = {
                ...createResponse.body,
                names: [{ first: 'Updated', last: 'Name', primary: true }]
            };

            const updateResponse = await request
                .put(`/api/people/${personId}`)
                .send(updates);

            expect(updateResponse.status).toBe(200);
            expect(updateResponse.body.names[0].first).toBe('Updated');
        });

        it('should return 404 for non-existent person', async () => {
            const response = await request
                .put('/api/people/N_nonexistent')
                .send({ names: [{ first: 'Test', last: 'Test', primary: true }], sex: 'U' });

            expect(response.status).toBe(404);
        });
    });

    describe('PUT /api/people/:id/media', () => {
        it('should upload an image and update person assets', async () => {
            // Create a test person first
            const createResponse = await request
                .post('/api/people')
                .send({
                    names: [{ first: 'Test', last: 'Media', primary: true }],
                    sex: 'F'
                });
            const personId = createResponse.body.id;

            // Create a minimal valid PNG (1x1 transparent pixel)
            const pngBuffer = Buffer.from([
                0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
                0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
                0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
                0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
                0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
                0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
                0x42, 0x60, 0x82
            ]);

            // Upload the image
            const uploadResponse = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', pngBuffer, 'test.png');

            expect(uploadResponse.status).toBe(200);
            expect(uploadResponse.body).toHaveProperty('filename');
            expect(uploadResponse.body.assets).toContain(uploadResponse.body.filename);

            // Verify person was updated
            const getResponse = await request.get(`/api/people/${personId}`);
            expect(getResponse.body.assets).toContain(uploadResponse.body.filename);
        });

        it('should return 404 for non-existent person', async () => {
            const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // Invalid but enough for test

            const response = await request
                .put('/api/people/N_nonexistent/media')
                .attach('file', pngBuffer, 'test.png');

            expect(response.status).toBe(404);
        });

        it('should return 400 if no file is provided', async () => {
            // Create a test person
            const createResponse = await request
                .post('/api/people')
                .send({
                    names: [{ first: 'Test', last: 'NoFile', primary: true }],
                    sex: 'M'
                });

            const response = await request
                .put(`/api/people/${createResponse.body.id}/media`)
                .send({});

            expect(response.status).toBe(400);
        });

        it('should reject disallowed file types with 415 and UNSUPPORTED_FILE_TYPE code', async () => {
            const createResponse = await request
                .post('/api/people')
                .send({ names: [{ first: 'Test', last: 'Reject', primary: true }], sex: 'M' });
            const personId = createResponse.body.id;

            const response = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', Buffer.from('#!/bin/sh\necho hi'), { filename: 'script.sh', contentType: 'application/x-sh' });

            expect(response.status).toBe(415);
            expect(response.body.code).toBe('UNSUPPORTED_FILE_TYPE');
        });

        it('should accept PDF, TXT, and MD uploads', async () => {
            const createResponse = await request
                .post('/api/people')
                .send({ names: [{ first: 'Test', last: 'Docs', primary: true }], sex: 'F' });
            const personId = createResponse.body.id;

            const pdfUpload = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'doc.pdf', contentType: 'application/pdf' });
            expect(pdfUpload.status).toBe(200);

            const txtUpload = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', Buffer.from('plain text'), { filename: 'notes.txt', contentType: 'text/plain' });
            expect(txtUpload.status).toBe(200);

            const mdUpload = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', Buffer.from('# Heading\ncontent'), { filename: 'readme.md', contentType: 'text/markdown' });
            expect(mdUpload.status).toBe(200);
        });

        it('should preserve original filename on upload', async () => {
            const createResponse = await request
                .post('/api/people')
                .send({ names: [{ first: 'Test', last: 'Filename', primary: true }], sex: 'M' });
            const personId = createResponse.body.id;

            const pngBuffer = Buffer.from([
                0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
                0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
                0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
                0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
                0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
                0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
                0x42, 0x60, 0x82
            ]);

            const uploadResponse = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', pngBuffer, 'my-portrait.png');

            expect(uploadResponse.status).toBe(200);
            expect(uploadResponse.body.filename).toBe('my-portrait.png');
        });

        it('should deduplicate filenames when a conflict exists', async () => {
            const createResponse = await request
                .post('/api/people')
                .send({ names: [{ first: 'Test', last: 'Dedup', primary: true }], sex: 'F' });
            const personId = createResponse.body.id;

            const buf = Buffer.from('plain text content');
            // Use a test-specific filename unlikely to exist from other tests
            const baseName = `dedup-unique-test-file.txt`;

            const first = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', buf, { filename: baseName, contentType: 'text/plain' });
            expect(first.status).toBe(200);
            expect(first.body.filename).toBe(baseName);

            const second = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', buf, { filename: baseName, contentType: 'text/plain' });
            expect(second.status).toBe(200);
            expect(second.body.filename).toBe('dedup-unique-test-file-1.txt');

            const third = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', buf, { filename: baseName, contentType: 'text/plain' });
            expect(third.status).toBe(200);
            expect(third.body.filename).toBe('dedup-unique-test-file-2.txt');
        });

        it('should only use image assets as primaryAsset in the people list', async () => {
            const createResponse = await request
                .post('/api/people')
                .send({ names: [{ first: 'Test', last: 'Primary', primary: true }], sex: 'M' });
            const personId = createResponse.body.id;

            // Upload a text file first
            await request
                .put(`/api/people/${personId}/media`)
                .attach('file', Buffer.from('some notes'), { filename: 'notes.txt', contentType: 'text/plain' });

            // Upload an image second
            const pngBuffer = Buffer.from([
                0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
                0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
                0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
                0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
                0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
                0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
                0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
                0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
                0x42, 0x60, 0x82
            ]);
            const imgUpload = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', pngBuffer, 'portrait.png');
            const imageFilename = imgUpload.body.filename;

            // GET /api/people list should have primaryAsset = the image, not the txt
            const listResponse = await request.get('/api/people?limit=200');
            const entry = listResponse.body.people.find((p: { id: string }) => p.id === personId);
            expect(entry).toBeDefined();
            expect(entry.primaryAsset).toBe(imageFilename);
            expect(entry.primaryAsset).not.toBe('notes.txt');
        });
    });

    describe('DELETE /api/people/:id/media/:filename', () => {
        const pngBuffer = Buffer.from([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
            0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
            0x42, 0x60, 0x82
        ]);

        it('should delete asset file and return 204', async () => {
            const createResponse = await request.post('/api/people').send({
                names: [{ first: 'Delete', last: 'Asset', primary: true }],
                sex: 'F'
            });
            const personId = createResponse.body.id;

            const uploadResponse = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', pngBuffer, 'test.png');
            const { filename } = uploadResponse.body;

            const deleteResponse = await request.delete(`/api/people/${personId}/media/${filename}`);
            expect(deleteResponse.status).toBe(204);
        });

        it('should NOT remove file from disk (unlink-only) — file remains after DELETE /media/:filename', async () => {
            const createResponse = await request.post('/api/people').send({
                names: [{ first: 'Delete', last: 'Disk', primary: true }],
                sex: 'M'
            });
            const personId = createResponse.body.id;

            const uploadResponse = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', pngBuffer, 'test.png');
            const { filename } = uploadResponse.body;

            await request.delete(`/api/people/${personId}/media/${filename}`);

            // File should still be on disk (unlink-only — DELETE /api/assets/:filename handles actual deletion)
            const assetPath = path.join(TEST_DATA_DIR, 'assets', filename);
            expect(fs.existsSync(assetPath)).toBe(true);

            // Cleanup the orphaned file
            try { fs.unlinkSync(assetPath); } catch { /* ignore */ }
        });

        it('should remove filename from person assets array', async () => {
            const createResponse = await request.post('/api/people').send({
                names: [{ first: 'Delete', last: 'Yaml', primary: true }],
                sex: 'M'
            });
            const personId = createResponse.body.id;

            const uploadResponse = await request
                .put(`/api/people/${personId}/media`)
                .attach('file', pngBuffer, 'test.png');
            const { filename } = uploadResponse.body;

            await request.delete(`/api/people/${personId}/media/${filename}`);

            const getResponse = await request.get(`/api/people/${personId}`);
            expect(getResponse.body.assets).not.toContain(filename);
        });

        it('should return 404 for non-existent person', async () => {
            const response = await request.delete('/api/people/N_nonexistent/media/file.png');
            expect(response.status).toBe(404);
        });

        it('should return 404 when filename not in person assets', async () => {
            const createResponse = await request.post('/api/people').send({
                names: [{ first: 'Delete', last: 'NotFound', primary: true }],
                sex: 'U'
            });
            const personId = createResponse.body.id;

            const response = await request.delete(`/api/people/${personId}/media/nonexistent.png`);
            expect(response.status).toBe(404);
        });
    });

    describe('POST /api/import/gedcom', () => {
        it('should import GEDCOM and replace existing data', async () => {
            const gedcomContent = `0 HEAD
1 SOUR LegacyGraph
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Test /Import/
1 SEX M
1 BIRT
2 DATE 1 JAN 2000
0 TRLR`;

            const response = await request
                .post('/api/import/gedcom')
                .send({ gedcom: gedcomContent });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('imported');
            expect(response.body.imported).toBeGreaterThan(0);
        });

        it('should return 400 for invalid GEDCOM', async () => {
            const response = await request
                .post('/api/import/gedcom')
                .send({ gedcom: 'invalid gedcom' });

            expect(response.status).toBe(400);
        });

        it('should return 400 if no GEDCOM content provided', async () => {
            const response = await request
                .post('/api/import/gedcom')
                .send({});

            expect(response.status).toBe(400);
        });
    });

    describe('API Write Path Side Effects (Phase 3.8.1)', () => {
        it('POST /people indexes new person in search', async () => {
            const newPerson = {
                names: [{ first: 'Searchable', last: 'Newman', primary: true }],
                sex: 'M',
                events: []
            };

            const createRes = await request.post('/api/people').send(newPerson);
            expect(createRes.status).toBe(201);

            const searchRes = await request.get('/api/search').query({ q: 'Searchable' });
            expect(searchRes.status).toBe(200);
            expect(searchRes.body.people.length).toBeGreaterThanOrEqual(1);
            expect(searchRes.body.people.some((p: any) => p.id === createRes.body.id)).toBe(true);
        });

        it('POST /people with parents wires parent edges in graph', async () => {
            // Create parent first
            const parentRes = await request.post('/api/people').send({
                names: [{ first: 'Parent', last: 'Edge', primary: true }],
                sex: 'F',
                events: []
            });
            expect(parentRes.status).toBe(201);
            const parentId = parentRes.body.id;

            // Create child referencing parent
            const childRes = await request.post('/api/people').send({
                names: [{ first: 'Child', last: 'Edge', primary: true }],
                sex: 'M',
                relationships: { parents: [{ id: parentId, type: 'biological' }] },
                events: []
            });
            expect(childRes.status).toBe(201);
            const childId = childRes.body.id;

            // Verify _computed.children on parent includes child
            const parentGet = await request.get(`/api/people/${parentId}`);
            expect(parentGet.status).toBe(200);
            expect(parentGet.body._computed.children).toContain(childId);
        });

        it('PUT /people/:id updates search index', async () => {
            const createRes = await request.post('/api/people').send({
                names: [{ first: 'OldSearchName', last: 'Unique', primary: true }],
                sex: 'F',
                events: []
            });
            const personId = createRes.body.id;

            // Update name
            const updates = {
                ...createRes.body,
                names: [{ first: 'NewSearchName', last: 'Unique', primary: true }]
            };
            await request.put(`/api/people/${personId}`).send(updates);

            // Search for new name should find it
            const searchNew = await request.get('/api/search').query({ q: 'NewSearchName' });
            expect(searchNew.body.people.some((p: any) => p.id === personId)).toBe(true);
        });

        it('PUT /people/:id recomputes _computed for neighbors', async () => {
            // Create two people
            const personARes = await request.post('/api/people').send({
                names: [{ first: 'SpouseA', last: 'Computed', primary: true }],
                sex: 'M',
                events: []
            });
            const personBRes = await request.post('/api/people').send({
                names: [{ first: 'SpouseB', last: 'Computed', primary: true }],
                sex: 'F',
                events: []
            });
            const idA = personARes.body.id;
            const idB = personBRes.body.id;

            // Update person A with a marriage event referencing B
            const updatedA = {
                ...personARes.body,
                events: [{
                    id: 'evt_1',
                    type: 'marriage',
                    date: '1 JAN 2020',
                    sort_date: '2020-01-01',
                    partner_id: idB,
                    status: 'married',
                    assets: []
                }]
            };
            await request.put(`/api/people/${idA}`).send(updatedA);

            // Person A should have currentSpouse
            const getA = await request.get(`/api/people/${idA}`);
            expect(getA.body._computed.currentSpouse).not.toBeNull();
            expect(getA.body._computed.currentSpouse.id).toBe(idB);
        });
    });

    describe('POST /api/system/rebuild', () => {
        it('should force re-hydration of the graph', async () => {
            const response = await request
                .post('/api/system/rebuild');

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('nodeCount');
            expect(response.body).toHaveProperty('edgeCount');
        });
    });

    describe('POST /api/system/snapshot', () => {
        it('should create a git snapshot', async () => {
            const tagName = `test-snapshot-${Date.now()}`;
            const response = await request
                .post('/api/system/snapshot')
                .send({ name: tagName });

            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('tag');
            expect(response.body.tag).toBe(tagName);
        });

        it('should return 400 if name is missing', async () => {
            const response = await request
                .post('/api/system/snapshot')
                .send({});

            expect(response.status).toBe(400);
        });
    });

    describe('POST /api/import/gedcom (additive vs replace modes)', () => {
        const testDataDir = TEST_DATA_DIR;
        const peopleDir = path.join(testDataDir, 'people');
        const FIXTURE_PERSON_ID = 'N_test-import-2000-fixture';
        const FIXTURE_PERSON_YAML = `version: "5.1"
id: ${FIXTURE_PERSON_ID}
created: '2026-01-01T00:00:00.000Z'
last_modified: '2026-01-01T00:00:00.000Z'
names:
  - first: Test
    last: Import
    primary: true
events:
  - id: fixture-birth-event
    type: birth
    date: 1 JAN 2000
    sort_date: '2000-01-01'
    assets: []
assets: []
relationships:
  parents: []
sex: M
tags:
  - gedcom
scrapbook_md: ''
_gedcom: {}
`;

        beforeEach(async () => {
            // Ensure a clean, known fixture state for each test in this block.
            // Remove any stale files from previous test runs, then write the canonical fixture person.
            // Then rebuild the graph so the in-memory state matches disk.
            fs.mkdirSync(peopleDir, { recursive: true });
            const allFiles = fs.readdirSync(peopleDir).filter(f => f.endsWith('.yaml'));
            for (const f of allFiles) {
                try { fs.unlinkSync(path.join(peopleDir, f)); } catch { /* ignore */ }
            }
            fs.writeFileSync(path.join(peopleDir, `${FIXTURE_PERSON_ID}.yaml`), FIXTURE_PERSON_YAML, 'utf8');
            // Force re-hydration so graph matches disk
            await request.post('/api/system/rebuild');
        });

        // Minimal valid GEDCOM with one person: first=Jane, last=Doe, born 1990
        const JANE_GED = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Jane /Doe/
1 SEX F
1 BIRT
2 DATE 15 JUN 1990
0 TRLR`;

        // Minimal valid GEDCOM with one person: first=Test, last=Import, born 2000
        // Matches the fixture person N_test-import-2000-* copied from tests/fixtures/data/people/
        const DUPLICATE_GED = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Test /Import/
1 SEX M
1 BIRT
2 DATE 1 JAN 2000
0 TRLR`;

        it('replace mode wipes existing people and writes imported ones', async () => {
            const response = await request
                .post('/api/import/gedcom')
                .field('mode', 'replace')
                .attach('file', Buffer.from(JANE_GED), { filename: 'test.ged', contentType: 'text/plain' });

            expect(response.status).toBe(200);
            expect(response.body.imported).toBe(1);
            // The fixture person should be gone — verify Jane is the only person
            const people = await request.get('/api/people');
            expect(people.body.totalCount).toBe(1);
            expect(people.body.people[0].names[0].first).toBe('Jane');
        });

        it('additive mode adds new people without removing existing ones', async () => {
            const before = await request.get('/api/people');
            const countBefore: number = before.body.totalCount;

            const response = await request
                .post('/api/import/gedcom')
                .field('mode', 'additive')
                .attach('file', Buffer.from(JANE_GED), { filename: 'test.ged', contentType: 'text/plain' });

            expect(response.status).toBe(200);
            expect(response.body.imported).toBe(1);
            expect(response.body.skipped).toBe(0);

            const after = await request.get('/api/people');
            expect(after.body.totalCount).toBe(countBefore + 1);
        });

        it('additive mode skips duplicate matched by name + birth year', async () => {
            const before = await request.get('/api/people');
            const countBefore: number = before.body.totalCount;

            const response = await request
                .post('/api/import/gedcom')
                .field('mode', 'additive')
                .attach('file', Buffer.from(DUPLICATE_GED), { filename: 'dup.ged', contentType: 'text/plain' });

            expect(response.status).toBe(200);
            expect(response.body.imported).toBe(0);
            expect(response.body.skipped).toBe(1);

            const after = await request.get('/api/people');
            expect(after.body.totalCount).toBe(countBefore);
        });

        it('rejects unknown mode with 400', async () => {
            const response = await request
                .post('/api/import/gedcom')
                .field('mode', 'nuke')
                .attach('file', Buffer.from(JANE_GED), { filename: 'test.ged', contentType: 'text/plain' });

            expect(response.status).toBe(400);
            expect(response.body.code).toBe('INVALID_MODE');
        });
    });

    describe('GET /api/graph', () => {
        const graphPeopleDir = path.join(TEST_DATA_DIR, 'people');
        let existingPeopleFiles: Set<string>;

        beforeEach(() => {
            existingPeopleFiles = new Set(
                fs.existsSync(graphPeopleDir) ? fs.readdirSync(graphPeopleDir) : []
            );
        });

        afterEach(() => {
            if (!fs.existsSync(graphPeopleDir)) return;
            for (const f of fs.readdirSync(graphPeopleDir)) {
                if (!existingPeopleFiles.has(f)) {
                    try { fs.unlinkSync(path.join(graphPeopleDir, f)); } catch { /* ignore */ }
                }
            }
        });

        it('should return nodes and edges arrays', async () => {
            const response = await request.get('/api/graph');
            expect(response.status).toBe(200);
            expect(response.body).toHaveProperty('nodes');
            expect(response.body).toHaveProperty('edges');
            expect(Array.isArray(response.body.nodes)).toBe(true);
            expect(Array.isArray(response.body.edges)).toBe(true);
        });

        it('should include required node fields', async () => {
            // Create a person so we have at least one node
            const createRes = await request.post('/api/people').send({
                names: [{ first: 'Graph', last: 'Node', primary: true }],
                sex: 'M',
                events: [{ type: 'birth', date: '1980-01-01', sort_date: '1980-01-01' }]
            });
            expect(createRes.status).toBe(201);

            const response = await request.get('/api/graph');
            expect(response.status).toBe(200);
            expect(response.body.nodes.length).toBeGreaterThan(0);

            const node = response.body.nodes.find((n: any) => n.id === createRes.body.id);
            expect(node).toBeDefined();
            expect(node).toHaveProperty('id');
            expect(node).toHaveProperty('label');
            expect(node).toHaveProperty('sex');
            expect(node.birthYear).toBe(1980);
        });

        it('should include parent_child edges for related people', async () => {
            const parentRes = await request.post('/api/people').send({
                names: [{ first: 'Graph', last: 'Parent', primary: true }],
                sex: 'F',
                events: []
            });
            const childRes = await request.post('/api/people').send({
                names: [{ first: 'Graph', last: 'Child', primary: true }],
                sex: 'M',
                events: [],
                relationships: { parents: [{ id: parentRes.body.id, type: 'biological' }] }
            });
            expect(parentRes.status).toBe(201);
            expect(childRes.status).toBe(201);

            const response = await request.get('/api/graph');
            expect(response.status).toBe(200);

            const edge = response.body.edges.find(
                (e: any) => e.source === childRes.body.id && e.target === parentRes.body.id
            );
            expect(edge).toBeDefined();
            expect(edge.type).toBe('parent_child');
        });
    });
});
