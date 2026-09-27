import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server';
import supertest from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Heavy fields (scrapbook_md, _gedcom) are stripped from the in-memory graph and
 * lazy-loaded from the person's YAML. People created through the API must keep
 * them across later edits, whether or not the file watcher ever re-reads the file.
 */
describe('Heavy fields of API-created people', () => {
    let server: FastifyInstance;
    let request: ReturnType<typeof supertest>;
    let dataDir: string;

    beforeEach(async () => {
        // Canonical path (no symlinks, e.g. macOS /var → /private/var) so the
        // watcher's event paths match the app's self-write keys exactly.
        dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-fields-test-')));
        fs.mkdirSync(path.join(dataDir, 'people'), { recursive: true });

        server = await createServer({ logger: false, dataDir });
        await server.listen({ port: 0 });
        const address = server.server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 3000;
        request = supertest(`http://localhost:${port}`);
    });

    afterEach(async () => {
        await server.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    async function createPerson() {
        const res = await request.post('/api/people').send({
            names: [{ first: 'Ada', last: 'Notebook', primary: true }],
            sex: 'F',
            events: [],
            scrapbook_md: '# Family notes\n\nKept in the notebook.',
            _gedcom: { xref: '@I1@' },
        });
        expect(res.status).toBe(201);
        return res.body.id as string;
    }

    it('keeps scrapbook_md and _gedcom when a PUT omits them', async () => {
        const id = await createPerson();

        const put = await request.put(`/api/people/${id}`).send({
            names: [{ first: 'Ada', last: 'Renamed', primary: true }],
        });
        expect(put.status).toBe(200);
        expect(put.body.scrapbook_md).toBe('# Family notes\n\nKept in the notebook.');
        expect(put.body._gedcom).toEqual({ xref: '@I1@' });

        const get = await request.get(`/api/people/${id}`).expect(200);
        expect(get.body.names[0].last).toBe('Renamed');
        expect(get.body.scrapbook_md).toBe('# Family notes\n\nKept in the notebook.');

        const onDisk = fs.readFileSync(path.join(dataDir, 'people', `${id}.yaml`), 'utf8');
        expect(onDisk).toContain('Kept in the notebook.');
    });

    it('returns scrapbook_md from GET right after creation', async () => {
        const id = await createPerson();

        const get = await request.get(`/api/people/${id}`).expect(200);
        expect(get.body.scrapbook_md).toBe('# Family notes\n\nKept in the notebook.');
    });
});
