// tests/core/TransactionManager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as nodeFs from 'fs';
import * as path from 'path';
import git from 'isomorphic-git';
import { TransactionManager } from '../../src/core/TransactionManager';

const REPO_DIR = path.join(__dirname, 'temp_repo');

describe('TransactionManager', () => {
    let txManager: TransactionManager;

    beforeEach(async () => {
        // Initialize a real git repo using isomorphic-git
        if (fs.existsSync(REPO_DIR)) fs.rmSync(REPO_DIR, { recursive: true, force: true });
        fs.mkdirSync(REPO_DIR, { recursive: true });
        await git.init({ fs: nodeFs, dir: REPO_DIR });
        await git.setConfig({ fs: nodeFs, dir: REPO_DIR, path: 'user.name', value: 'Tester' });
        await git.setConfig({ fs: nodeFs, dir: REPO_DIR, path: 'user.email', value: 'test@test.com' });

        txManager = new TransactionManager(REPO_DIR, { debounceMs: 200 }); // Short debounce for tests
    });

    afterEach(async () => {
        await txManager.destroy();
        fs.rmSync(REPO_DIR, { recursive: true, force: true });
    });

    it('should write file to disk immediately', async () => {
        await txManager.writeFile('people/test.yaml', 'name: Test', 'Test Person');

        const content = fs.readFileSync(path.join(REPO_DIR, 'people/test.yaml'), 'utf8');
        expect(content).toBe('name: Test');
    });

    it('should batch rapid writes into a single git commit', async () => {
        // Write 3 files in rapid succession
        await txManager.writeFile('people/a.yaml', 'name: A', 'Person A');
        await txManager.writeFile('people/b.yaml', 'name: B', 'Person B');
        await txManager.writeFile('people/c.yaml', 'name: C', 'Person C');

        // All 3 files should exist on disk immediately
        expect(fs.existsSync(path.join(REPO_DIR, 'people/a.yaml'))).toBe(true);
        expect(fs.existsSync(path.join(REPO_DIR, 'people/b.yaml'))).toBe(true);
        expect(fs.existsSync(path.join(REPO_DIR, 'people/c.yaml'))).toBe(true);

        // Flush to commit all pending writes (tests batching without timer flakiness)
        await txManager.flush();

        // Verify exactly ONE commit was created (not 3 separate ones) via isomorphic-git
        const log = await git.log({ fs: nodeFs, dir: REPO_DIR });
        expect(log.length).toBe(1);
        expect(log[0].commit.message).toContain('Update 3 files');
    });

    it('should flush pending changes immediately on demand', async () => {
        await txManager.writeFile('people/flush.yaml', 'name: Flush', 'Flush Test');

        // Flush immediately — don't wait for debounce
        await txManager.flush();

        const log = await git.log({ fs: nodeFs, dir: REPO_DIR });
        expect(log.length).toBe(1);
        expect(log[0].commit.message).toContain('Update 1 file');
    });

    it('should not create empty commits when no pending changes', async () => {
        await txManager.flush(); // Nothing pending

        try {
            const log = await git.log({ fs: nodeFs, dir: REPO_DIR });
            expect(log.length).toBe(0);
        } catch {
            // No commits at all — expected for an empty repo (isomorphic-git throws NotFoundError)
        }
    });

    it('should include file labels in commit message', async () => {
        await txManager.writeFile('people/john.yaml', 'name: John', 'John Doe');
        await txManager.writeFile('people/jane.yaml', 'name: Jane', 'Jane Doe');
        await txManager.flush();

        const log = await git.log({ fs: nodeFs, dir: REPO_DIR });
        expect(log[0].commit.message).toContain('John Doe');
        expect(log[0].commit.message).toContain('Jane Doe');
    });

    it('should truncate commit messages at 72 chars', async () => {
        // Write many files to create a very long commit message
        for (let i = 0; i < 20; i++) {
            await txManager.writeFile(`people/p${i}.yaml`, `name: Person${i}`, `Person ${i}`);
        }
        await txManager.flush();

        const log = await git.log({ fs: nodeFs, dir: REPO_DIR });
        // First line of commit message should be ≤72 chars
        const firstLine = log[0].commit.message.split('\n')[0];
        expect(firstLine.length).toBeLessThanOrEqual(72);
    });

    it('should handle sequential batches correctly', async () => {
        // First batch
        await txManager.writeFile('people/first.yaml', 'name: First', 'First');
        await txManager.flush();

        // Second batch
        await txManager.writeFile('people/second.yaml', 'name: Second', 'Second');
        await txManager.flush();

        const log = await git.log({ fs: nodeFs, dir: REPO_DIR });
        expect(log.length).toBe(2);
    });

    it('should use isomorphic-git for in-process git operations (no child-process spawning)', () => {
        // Migration verification: TransactionManager must use isomorphic-git (pure JS, in-process)
        // instead of simple-git (which spawns child processes for every git command).
        const sourcePath = path.resolve(__dirname, '../../src/core/TransactionManager.ts');
        const source = fs.readFileSync(sourcePath, 'utf8');
        expect(source).not.toContain("from 'simple-git'");
        expect(source).toContain('isomorphic-git');
    });

    describe('batches where a file changes state more than once', () => {
        const headFiles = async () => {
            const oid = await git.resolveRef({ fs: nodeFs, dir: REPO_DIR, ref: 'HEAD' });
            return git.listFiles({ fs: nodeFs, dir: REPO_DIR, ref: oid });
        };
        const commitCount = async () => {
            try {
                return (await git.log({ fs: nodeFs, dir: REPO_DIR })).length;
            } catch {
                return 0; // No commits yet
            }
        };

        it('commits the rest of a batch when a new file is written then deleted before the commit', async () => {
            await txManager.writeFile('people/gone.yaml', 'name: Gone', 'Gone');
            fs.rmSync(path.join(REPO_DIR, 'people/gone.yaml'));
            await txManager.removeFile('people/gone.yaml', 'Gone');
            await txManager.writeFile('people/kept.yaml', 'name: Kept', 'Kept');

            await txManager.flush();

            expect(txManager.hasPending()).toBe(false);
            expect(await headFiles()).toEqual(['people/kept.yaml']);
        });

        it('keeps committing later batches after a write-then-delete batch', async () => {
            // An uploaded asset deleted before its commit: tracked, then removed from disk
            fs.mkdirSync(path.join(REPO_DIR, 'assets'), { recursive: true });
            fs.writeFileSync(path.join(REPO_DIR, 'assets/photo.jpg'), 'jpg');
            await txManager.trackFile('assets/photo.jpg', 'asset photo.jpg');
            fs.rmSync(path.join(REPO_DIR, 'assets/photo.jpg'));
            await txManager.removeFile('assets/photo.jpg', 'asset photo.jpg');
            await txManager.flush();

            await txManager.writeFile('people/later.yaml', 'name: Later', 'Later');
            await txManager.flush();

            expect(txManager.hasPending()).toBe(false);
            expect(await commitCount()).toBe(1);
            expect(await headFiles()).toEqual(['people/later.yaml']);
        });

        it('commits a file written then deleted without a removeFile call as absent', async () => {
            await txManager.writeFile('people/base.yaml', 'name: Base', 'Base');
            await txManager.writeFile('people/vanished.yaml', 'name: Vanished', 'Vanished');
            fs.rmSync(path.join(REPO_DIR, 'people/vanished.yaml'));

            await txManager.flush();

            expect(txManager.hasPending()).toBe(false);
            expect(await headFiles()).toEqual(['people/base.yaml']);
        });

        it('removes a committed file that is rewritten then deleted within one batch', async () => {
            await txManager.writeFile('people/keep.yaml', 'name: Keep', 'Keep');
            await txManager.writeFile('people/old.yaml', 'name: Old', 'Old');
            await txManager.flush();

            await txManager.writeFile('people/old.yaml', 'name: Old v2', 'Old');
            fs.rmSync(path.join(REPO_DIR, 'people/old.yaml'));
            await txManager.removeFile('people/old.yaml', 'Old');
            await txManager.flush();

            expect(txManager.hasPending()).toBe(false);
            expect(await commitCount()).toBe(2);
            expect(await headFiles()).toEqual(['people/keep.yaml']);
        });

        it('commits the final content of a file deleted then recreated within one batch', async () => {
            await txManager.writeFile('people/back.yaml', 'name: Back', 'Back');
            await txManager.flush();

            fs.rmSync(path.join(REPO_DIR, 'people/back.yaml'));
            await txManager.removeFile('people/back.yaml', 'Back');
            await txManager.writeFile('people/back.yaml', 'name: Back again', 'Back');
            await txManager.flush();

            const oid = await git.resolveRef({ fs: nodeFs, dir: REPO_DIR, ref: 'HEAD' });
            const { blob } = await git.readBlob({ fs: nodeFs, dir: REPO_DIR, oid, filepath: 'people/back.yaml' });
            expect(Buffer.from(blob).toString('utf8')).toBe('name: Back again');
        });

        it('does not create an empty commit when a batch nets out to no change', async () => {
            await txManager.writeFile('people/base.yaml', 'name: Base', 'Base');
            await txManager.flush();

            await txManager.writeFile('people/temp.yaml', 'name: Temp', 'Temp');
            fs.rmSync(path.join(REPO_DIR, 'people/temp.yaml'));
            await txManager.removeFile('people/temp.yaml', 'Temp');
            await txManager.flush();

            expect(txManager.hasPending()).toBe(false);
            expect(await commitCount()).toBe(1);
        });
    });

    describe('paths outside the root', () => {
        const outside = path.join(REPO_DIR, '..', 'tx-escape.txt');

        afterEach(() => {
            fs.rmSync(outside, { force: true });
        });

        it('writeFile rejects a path that escapes the root and writes nothing', async () => {
            await expect(txManager.writeFile('../tx-escape.txt', 'x', 'escape')).rejects.toThrow(/outside/);
            expect(fs.existsSync(outside)).toBe(false);
        });

        it('writeFile rejects an absolute path', async () => {
            await expect(txManager.writeFile(outside, 'x', 'escape')).rejects.toThrow(/outside/);
            expect(fs.existsSync(outside)).toBe(false);
        });

        it('trackFile and removeFile reject paths that escape the root', async () => {
            await expect(txManager.trackFile('../tx-escape.txt', 'escape')).rejects.toThrow(/outside/);
            await expect(txManager.removeFile('people/../../tx-escape.txt', 'escape')).rejects.toThrow(/outside/);
        });
    });
});
