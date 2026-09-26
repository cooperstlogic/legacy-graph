import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server';
import type { AppInstance } from '../../src/api/types';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

describe('GET /api/map/events', () => {
    let server: FastifyInstance;
    let tmp: string;

    async function writePerson(id: string, body: Record<string, unknown>) {
        await fs.writeFile(path.join(tmp, 'people', `${id}.yaml`), yaml.dump(body), 'utf8');
    }

    function basePerson(id: string, name: string, extra: Record<string, unknown> = {}) {
        return {
            version: '5.1',
            id,
            created: '2024-01-01T00:00:00Z',
            last_modified: '2024-01-01T00:00:00Z',
            names: [{ first: name, last: 'Test', primary: true }],
            sex: 'U',
            relationships: { parents: [] },
            events: [],
            assets: [],
            scrapbook_md: '',
            ...extra,
        };
    }

    beforeAll(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'map-events-test-'));
        await fs.mkdir(path.join(tmp, 'people'), { recursive: true });
        await fs.mkdir(path.join(tmp, 'assets'), { recursive: true });
        await fs.mkdir(path.join(tmp, '_meta'), { recursive: true });

        // Focal has a birth event in London, a residence range in Paris.
        await writePerson('N_focal-test-0000-london-aaaa1111', basePerson('N_focal-test-0000-london-aaaa1111', 'Focal', {
            events: [
                {
                    id: 'b1', type: 'birth', date: '1900', sort_date: '1900-01-01',
                    location: { name: 'London', lat: 51.5, lng: -0.12 },
                    assets: [],
                },
                {
                    id: 'r1', type: 'residence',
                    date: '1930', sort_date: '1930-01-01',
                    end_date: '1940', sort_end_date: '1940-01-01',
                    location: { name: 'Paris', lat: 48.85, lng: 2.35 },
                    assets: [],
                },
                {
                    id: 'd1', type: 'death', date: '1970', sort_date: '1970-06-01',
                    location: { name: 'Unresolved Place' }, // no lat/lng — must be skipped
                    assets: [],
                },
            ],
        }));

        // Parent: geocoded birth in Rome
        await writePerson('N_parent-test-0000-rome-bbbb2222', basePerson('N_parent-test-0000-rome-bbbb2222', 'Parent', {
            events: [
                {
                    id: 'b2', type: 'birth', date: '1870', sort_date: '1870-01-01',
                    location: { name: 'Rome', lat: 41.9, lng: 12.48 },
                    assets: [],
                },
            ],
        }));

        // Child: linked to focal as parent; birth in Madrid.
        await writePerson('N_child-test-0000-madrid-cccc3333', basePerson('N_child-test-0000-madrid-cccc3333', 'Child', {
            relationships: { parents: [{ id: 'N_focal-test-0000-london-aaaa1111', type: 'biological' }] },
            events: [
                {
                    id: 'b3', type: 'birth', date: '1930', sort_date: '1930-01-01',
                    location: { name: 'Madrid', lat: 40.42, lng: -3.7 },
                    assets: [],
                },
            ],
        }));

        // Unrelated person: not in focal's lineage.
        await writePerson('N_other-test-0000-tokyo-dddd4444', basePerson('N_other-test-0000-tokyo-dddd4444', 'Other', {
            events: [
                {
                    id: 'b4', type: 'birth', date: '1950', sort_date: '1950-01-01',
                    location: { name: 'Tokyo', lat: 35.68, lng: 139.77 },
                    assets: [],
                },
            ],
        }));

        // Link focal as child of parent.
        const focalPath = path.join(tmp, 'people', 'N_focal-test-0000-london-aaaa1111.yaml');
        const focal = yaml.load(await fs.readFile(focalPath, 'utf8')) as Record<string, unknown>;
        focal.relationships = { parents: [{ id: 'N_parent-test-0000-rome-bbbb2222', type: 'biological' }] };
        await fs.writeFile(focalPath, yaml.dump(focal), 'utf8');

        server = await createServer({ dataDir: tmp, logger: false, awaitHydration: true });
    });

    afterAll(async () => {
        await server.close();
        await fs.rm(tmp, { recursive: true, force: true });
    });

    it('returns all geocoded events with lat/lng', async () => {
        const res = await server.inject({ method: 'GET', url: '/api/map/events' });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { events: Array<{ type: string; lat: number; lng: number }>; extent: unknown };
        // 5 events with lat/lng (birth+residence+child-birth+parent-birth+other-birth); the death has no lat/lng
        expect(body.events).toHaveLength(5);
        for (const e of body.events) {
            expect(typeof e.lat).toBe('number');
            expect(typeof e.lng).toBe('number');
        }
        expect(body.extent).toBeDefined();
    });

    it('filters by single person when ?person= is given', async () => {
        const res = await server.inject({
            method: 'GET',
            url: '/api/map/events?person=N_focal-test-0000-london-aaaa1111',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { events: Array<{ person_id: string; type: string }> };
        expect(body.events).toHaveLength(2); // birth + residence (death has no lat/lng)
        for (const e of body.events) {
            expect(e.person_id).toBe('N_focal-test-0000-london-aaaa1111');
        }
    });

    it('filters by lineage when ?lineage= is given', async () => {
        const res = await server.inject({
            method: 'GET',
            url: '/api/map/events?lineage=N_focal-test-0000-london-aaaa1111',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { events: Array<{ person_id: string }> };
        const ids = new Set(body.events.map(e => e.person_id));
        expect(ids.has('N_focal-test-0000-london-aaaa1111')).toBe(true);
        expect(ids.has('N_parent-test-0000-rome-bbbb2222')).toBe(true);
        expect(ids.has('N_child-test-0000-madrid-cccc3333')).toBe(true);
        expect(ids.has('N_other-test-0000-tokyo-dddd4444')).toBe(false);
    });

    it('returns 400 when both ?person= and ?lineage= are given', async () => {
        const res = await server.inject({
            method: 'GET',
            url: '/api/map/events?person=N_focal-test-0000-london-aaaa1111&lineage=N_focal-test-0000-london-aaaa1111',
        });
        expect(res.statusCode).toBe(400);
    });

    it('returns 404 for an unknown person id', async () => {
        const res = await server.inject({
            method: 'GET',
            url: '/api/map/events?person=N_unknown-xxxxxxxx',
        });
        expect(res.statusCode).toBe(404);
    });

    it('includes date-range fields on the returned events', async () => {
        const res = await server.inject({ method: 'GET', url: '/api/map/events?person=N_focal-test-0000-london-aaaa1111' });
        const body = res.json() as { events: Array<{ type: string; sort_date: string | null; sort_end_date: string | null }> };
        const residence = body.events.find(e => e.type === 'residence');
        expect(residence).toBeDefined();
        expect(residence!.sort_date).toBe('1930-01-01');
        expect(residence!.sort_end_date).toBe('1940-01-01');
    });

    it('caches responses and invalidates on graph-updated emission', async () => {
        const { graphEngine } = (server as AppInstance).appServices;
        const graph = graphEngine.getGraph();

        // Force a fresh cache state — earlier tests may have populated the same key.
        graphEngine.emit('graph-updated');

        const spy = vi.spyOn(graph, 'forEachNode');

        // Prime: first call walks the graph.
        const r1 = await server.inject({ method: 'GET', url: '/api/map/events' });
        expect(r1.statusCode).toBe(200);
        const callsAfterFirst = spy.mock.calls.length;
        expect(callsAfterFirst).toBeGreaterThan(0);

        // Second call within the cache window: must NOT walk the graph again.
        await server.inject({ method: 'GET', url: '/api/map/events' });
        expect(spy.mock.calls.length).toBe(callsAfterFirst);

        // Emit graph-updated → cache clears → next call walks again.
        graphEngine.emit('graph-updated');
        await server.inject({ method: 'GET', url: '/api/map/events' });
        expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst);

        spy.mockRestore();
    });

    it('caches per-scope independently (all vs person vs lineage)', async () => {
        const { graphEngine } = (server as AppInstance).appServices;
        const graph = graphEngine.getGraph();

        // Force a fresh cache state.
        graphEngine.emit('graph-updated');

        const spy = vi.spyOn(graph, 'forEachNode');

        await server.inject({ method: 'GET', url: '/api/map/events' });
        const after1 = spy.mock.calls.length;

        await server.inject({ method: 'GET', url: '/api/map/events?person=N_focal-test-0000-london-aaaa1111' });
        const after2 = spy.mock.calls.length;
        expect(after2).toBeGreaterThan(after1); // distinct cache key — walk happens

        await server.inject({ method: 'GET', url: '/api/map/events?person=N_focal-test-0000-london-aaaa1111' });
        expect(spy.mock.calls.length).toBe(after2); // cached now

        await server.inject({ method: 'GET', url: '/api/map/events?lineage=N_focal-test-0000-london-aaaa1111' });
        expect(spy.mock.calls.length).toBeGreaterThan(after2); // lineage is its own key

        spy.mockRestore();
    });
});
