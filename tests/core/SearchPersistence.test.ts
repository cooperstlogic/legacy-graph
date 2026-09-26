// tests/core/SearchPersistence.test.ts
// TDD: Search Index Persistence (Phase 3.7.2)
// Tests written BEFORE implementation — all should fail initially.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { GraphEngine } from '../../src/core/GraphEngine';
import { CACHE_SPEC_VERSION } from '../../src/core/GraphCache';

const DATA_DIR = path.join(__dirname, 'temp_search_persist');
const PEOPLE_DIR = path.join(DATA_DIR, 'people');
const STORIES_DIR = path.join(DATA_DIR, 'stories');
const META_DIR = path.join(DATA_DIR, '_meta');
const SEARCH_INDEX_PATH = path.join(META_DIR, '.search-index.json');

function writePersonYaml(id: string, first: string, last: string, scrapbook: string = '') {
    const content = `version: "5.1"
id: "${id}"
created: "2023-01-01T00:00:00Z"
last_modified: "2023-01-01T00:00:00Z"
names:
  - first: "${first}"
    last: "${last}"
sex: "U"
relationships:
  parents: []
events: []
assets: []
scrapbook_md: "${scrapbook}"
`;
    fs.writeFileSync(path.join(PEOPLE_DIR, `${id}.yaml`), content);
}

describe('Search Index Persistence (Phase 3.7.2)', () => {
    beforeEach(() => {
        if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
        fs.mkdirSync(PEOPLE_DIR, { recursive: true });
        fs.mkdirSync(STORIES_DIR, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    });

    it('should write search index file after hydration', async () => {
        writePersonYaml('N_A', 'Alice', 'Smith');
        writePersonYaml('N_B', 'Bob', 'Jones');

        const engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();

        expect(fs.existsSync(SEARCH_INDEX_PATH)).toBe(true);

        const cached = JSON.parse(fs.readFileSync(SEARCH_INDEX_PATH, 'utf8'));
        expect(cached.spec_version).toBe(CACHE_SPEC_VERSION);
        expect(cached.personIds).toContain('N_A');
        expect(cached.personIds).toContain('N_B');
    });

    it('should produce identical search results after import from cache', async () => {
        writePersonYaml('N_A', 'Alice', 'Smith', 'Famous mathematician');
        writePersonYaml('N_B', 'Bob', 'Jones');

        const engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();

        // Verify first hydration search works
        const results1 = await engine.searchService.search('Alice');
        expect(results1.people.length).toBe(1);
        expect(results1.people[0].id).toBe('N_A');

        // Second hydration should use cached search index
        const engine2 = new GraphEngine(DATA_DIR);
        await engine2.hydrate();

        const results2 = await engine2.searchService.search('Alice');
        expect(results2.people.length).toBe(1);
        expect(results2.people[0].id).toBe('N_A');

        // Bio search should also work from cached index
        const bioResults = await engine2.searchService.search('mathematician');
        expect(bioResults.people.length).toBe(1);
        expect(bioResults.people[0].id).toBe('N_A');
    });

    it('should re-index only changed nodes on incremental boot', async () => {
        writePersonYaml('N_A', 'Alice', 'Smith');
        writePersonYaml('N_B', 'Bob', 'Jones');

        const engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();

        // Verify initial search
        const results1 = await engine.searchService.search('Alice');
        expect(results1.people.length).toBe(1);

        // Modify one person's name
        await new Promise(r => setTimeout(r, 100));
        writePersonYaml('N_A', 'Alicia', 'Smith');

        // Second hydration — N_A re-parsed (mtime changed), N_B from cache
        const engine2 = new GraphEngine(DATA_DIR);
        const result = await engine2.hydrate();
        expect(result.parsed).toBe(1); // Only N_A re-parsed

        // Updated name should be searchable
        const results2 = await engine2.searchService.search('Alicia');
        expect(results2.people.length).toBe(1);
        expect(results2.people[0].id).toBe('N_A');

        // Old name should NOT match
        const oldResults = await engine2.searchService.search('Alice');
        expect(oldResults.people.length).toBe(0);

        // Unchanged person should still be searchable
        const bobResults = await engine2.searchService.search('Bob');
        expect(bobResults.people.length).toBe(1);
    });

    it('should handle deleted people on incremental boot', async () => {
        writePersonYaml('N_A', 'Alice', 'Smith');
        writePersonYaml('N_B', 'Bob', 'Jones');

        const engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();

        // Delete N_B from disk
        fs.unlinkSync(path.join(PEOPLE_DIR, 'N_B.yaml'));

        const engine2 = new GraphEngine(DATA_DIR);
        await engine2.hydrate();

        // Deleted person should not appear in search
        const results = await engine2.searchService.search('Bob');
        expect(results.people.length).toBe(0);

        // Remaining person should still be searchable
        const aliceResults = await engine2.searchService.search('Alice');
        expect(aliceResults.people.length).toBe(1);
    });

    it('should do full rebuild when search index is missing', async () => {
        writePersonYaml('N_A', 'Alice', 'Smith');

        const engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();

        // Delete search index but keep graph cache
        fs.unlinkSync(SEARCH_INDEX_PATH);

        const engine2 = new GraphEngine(DATA_DIR);
        await engine2.hydrate();

        // Search should still work (full rebuild fallback)
        const results = await engine2.searchService.search('Alice');
        expect(results.people.length).toBe(1);
    });

    it('should do full rebuild when search index is corrupt', async () => {
        writePersonYaml('N_A', 'Alice', 'Smith');

        const engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();

        // Corrupt the search index
        fs.writeFileSync(SEARCH_INDEX_PATH, 'NOT VALID JSON!!!');

        const engine2 = new GraphEngine(DATA_DIR);
        await engine2.hydrate();

        // Search should still work (full rebuild fallback)
        const results = await engine2.searchService.search('Alice');
        expect(results.people.length).toBe(1);
    });

    it('should do full rebuild on spec_version mismatch', async () => {
        writePersonYaml('N_A', 'Alice', 'Smith');

        const engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();

        // Write a search index with wrong version
        const cached = JSON.parse(fs.readFileSync(SEARCH_INDEX_PATH, 'utf8'));
        cached.spec_version = '4.0';
        fs.writeFileSync(SEARCH_INDEX_PATH, JSON.stringify(cached));

        const engine2 = new GraphEngine(DATA_DIR);
        await engine2.hydrate();

        // Search should still work (version mismatch triggers full rebuild)
        const results = await engine2.searchService.search('Alice');
        expect(results.people.length).toBe(1);
    });

    it('should invalidate search index on forceFullRebuild', async () => {
        writePersonYaml('N_A', 'Alice', 'Smith');

        const engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();

        expect(fs.existsSync(SEARCH_INDEX_PATH)).toBe(true);

        // Force rebuild should write a fresh search index
        await engine.hydrate({ forceFullRebuild: true });

        expect(fs.existsSync(SEARCH_INDEX_PATH)).toBe(true);
        const results = await engine.searchService.search('Alice');
        expect(results.people.length).toBe(1);
    });

    it('should debounce serialize search index on hot-patch updates', async () => {
        writePersonYaml('N_A', 'Alice', 'Smith');
        const engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();

        // Ensure index exists
        expect(fs.existsSync(SEARCH_INDEX_PATH)).toBe(true);
        const mtime1 = fs.statSync(SEARCH_INDEX_PATH).mtimeMs;

        // Simulate hot-patch API index call directly
        engine.searchService.indexPerson({
            version: "5.1", id: "N_A", created: "2023", last_modified: "2023",
            names: [{ first: "Alicia", last: "Smith" }], sex: "U",
            relationships: { parents: [] }, events: [], assets: [], tags: []
        }, "");

        // Should not have written immediately (debounced)
        const mtime2 = fs.statSync(SEARCH_INDEX_PATH).mtimeMs;
        expect(mtime2).toBe(mtime1);

        // Wait for debounce timer (e.g. 500ms)
        await new Promise(r => setTimeout(r, 600));

        // Should have written
        const mtime3 = fs.statSync(SEARCH_INDEX_PATH).mtimeMs;
        expect(mtime3).toBeGreaterThan(mtime1);
    });

    it('hydrate() leaves no debounced write pending (it exports the index itself)', async () => {
        writePersonYaml('N_A', 'Alice', 'Smith');
        const engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();

        // A leftover timer would rewrite the index ~500ms later, racing any caller
        // that deletes or moves the data dir right after hydration.
        fs.rmSync(SEARCH_INDEX_PATH);
        await new Promise(r => setTimeout(r, 600));
        expect(fs.existsSync(SEARCH_INDEX_PATH)).toBe(false);
    });

    it('close() writes a pending debounced index immediately and cancels the timer', async () => {
        writePersonYaml('N_A', 'Alice', 'Smith');
        const engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();
        fs.rmSync(SEARCH_INDEX_PATH);

        engine.searchService.indexPerson({
            version: "5.1", id: "N_A", created: "2023", last_modified: "2023",
            names: [{ first: "Alicia", last: "Smith" }], sex: "U",
            relationships: { parents: [] }, events: [], assets: [], tags: []
        }, "");
        await engine.close();

        // Flushed on close: shutdown must not lose the latest index
        expect(fs.readFileSync(SEARCH_INDEX_PATH, 'utf8')).toContain('N_A');

        // ...and the debounce timer is gone: nothing writes into the data dir afterwards
        // (a late write here raced test teardown, recreating _meta mid-`rm`: ENOTEMPTY)
        fs.rmSync(SEARCH_INDEX_PATH);
        await new Promise(r => setTimeout(r, 600));
        expect(fs.existsSync(SEARCH_INDEX_PATH)).toBe(false);
    });
});
