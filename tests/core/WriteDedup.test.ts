// tests/core/WriteDedup.test.ts
// TDD: Write-Event Deduplication (Phase 3.7.3)
// Tests written BEFORE implementation — all should fail initially.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';

import * as path from 'path';
import { GraphEngine } from '../../src/core/GraphEngine';

const DATA_DIR = path.join(__dirname, 'temp_write_dedup');
const PEOPLE_DIR = path.join(DATA_DIR, 'people');
const STORIES_DIR = path.join(DATA_DIR, 'stories');

function writePersonYaml(id: string, first: string, last: string) {
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
scrapbook_md: ""
`;
    fs.writeFileSync(path.join(PEOPLE_DIR, `${id}.yaml`), content);
}

describe('Write-Event Deduplication (Phase 3.7.3)', () => {
    let engine: GraphEngine;

    beforeEach(async () => {
        if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
        fs.mkdirSync(PEOPLE_DIR, { recursive: true });
        fs.mkdirSync(STORIES_DIR, { recursive: true });
        engine = new GraphEngine(DATA_DIR);
        await engine.hydrate();
    });

    afterEach(async () => {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    });

    describe('registerSelfWrite / consumeSelfWrite', () => {
        it('should register a self-written file path', () => {
            const filePath = path.join(PEOPLE_DIR, 'N_A.yaml');
            engine.registerSelfWrite(filePath);

            expect(engine.hasSelfWrite(filePath)).toBe(true);
        });

        it('should consume (remove) a self-write entry on check', () => {
            const filePath = path.join(PEOPLE_DIR, 'N_A.yaml');
            engine.registerSelfWrite(filePath);

            // First consume should return true and remove the entry
            expect(engine.consumeSelfWrite(filePath)).toBe(true);
            // Second consume should return false — entry was consumed
            expect(engine.consumeSelfWrite(filePath)).toBe(false);
        });

        it('should match a self-write registered through a symlinked or relative path', () => {
            // The watcher reports canonical paths; the app registers rootDir-joined ones
            // (relative DATA_DIR, macOS /var → /private/var). Both must hit the same entry.
            const linkDir = path.join(DATA_DIR, 'link');
            fs.symlinkSync(PEOPLE_DIR, linkDir);
            const realPath = path.join(fs.realpathSync(PEOPLE_DIR), 'N_A.yaml');

            engine.registerSelfWrite(path.join(linkDir, 'N_A.yaml'));
            expect(engine.consumeSelfWrite(realPath)).toBe(true);

            engine.registerSelfWrite(path.relative(process.cwd(), path.join(PEOPLE_DIR, 'N_B.yaml')));
            expect(engine.hasSelfWrite(path.join(fs.realpathSync(PEOPLE_DIR), 'N_B.yaml'))).toBe(true);
        });

        it('should return false for unregistered (external) file paths', () => {
            const filePath = path.join(PEOPLE_DIR, 'N_EXTERNAL.yaml');

            expect(engine.hasSelfWrite(filePath)).toBe(false);
            expect(engine.consumeSelfWrite(filePath)).toBe(false);
        });
    });

    describe('Watcher deduplication', () => {
        it('should skip hot-patch for self-written files', async () => {
            // Add a person to the graph directly
            writePersonYaml('N_A', 'Alice', 'Original');
            const filePath = path.join(PEOPLE_DIR, 'N_A.yaml');
            await (engine as any).handleFileUpdate(filePath);

            // Verify person exists
            expect(engine.getGraph().getNodeAttributes('N_A').data.names[0].first).toBe('Alice');

            // Register a self-write, then modify the file
            writePersonYaml('N_A', 'SelfWrite', 'Modified');
            engine.registerSelfWrite(filePath);

            // Spy on handleFileUpdate to verify it skips
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Simulate watcher firing — should skip because of self-write registration
            await (engine as any).handleFileUpdate(filePath);

            // Graph should still have OLD data (hot-patch was skipped)
            expect(engine.getGraph().getNodeAttributes('N_A').data.names[0].first).toBe('Alice');

            // Self-write entry should still be present (non-consuming check,
            // so duplicate watcher events from FSEvents are also filtered)
            expect(engine.hasSelfWrite(filePath)).toBe(true);

            consoleSpy.mockRestore();
        });

        it('should process external edits normally (not in self-write set)', async () => {
            // Add a person to the graph
            writePersonYaml('N_A', 'Alice', 'Original');
            const filePath = path.join(PEOPLE_DIR, 'N_A.yaml');
            await (engine as any).handleFileUpdate(filePath);

            // Modify the file WITHOUT registering a self-write (simulates external edit)
            writePersonYaml('N_A', 'ExternalEdit', 'Updated');

            // Hot-patch should process normally
            await (engine as any).handleFileUpdate(filePath);

            // Graph should have the UPDATED data
            expect(engine.getGraph().getNodeAttributes('N_A').data.names[0].first).toBe('ExternalEdit');
        });

        it('should skip handleFileRemove for self-written deletions', async () => {
            writePersonYaml('N_DEL', 'DeleteMe', 'Test');
            const filePath = path.join(PEOPLE_DIR, 'N_DEL.yaml');
            await (engine as any).handleFileUpdate(filePath);
            expect(engine.getGraph().hasNode('N_DEL')).toBe(true);

            // Register self-write for this path (the API deleted it)
            engine.registerSelfWrite(filePath);

            // Simulate watcher remove — should skip
            (engine as any).handleFileRemove(filePath);

            // Node should still exist in graph (the API handler already handled removal if needed)
            expect(engine.getGraph().hasNode('N_DEL')).toBe(true);
        });
    });

    describe('TTL expiration', () => {
        it('should expire self-write entries after TTL', async () => {
            const filePath = path.join(PEOPLE_DIR, 'N_A.yaml');

            // Register with a very short TTL for testing
            engine.registerSelfWrite(filePath, 50); // 50ms TTL

            expect(engine.hasSelfWrite(filePath)).toBe(true);

            // Wait for TTL to expire
            await new Promise(r => setTimeout(r, 100));

            // Entry should be expired
            expect(engine.hasSelfWrite(filePath)).toBe(false);
            expect(engine.consumeSelfWrite(filePath)).toBe(false);
        });
    });
});
