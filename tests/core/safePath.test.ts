// tests/core/safePath.test.ts
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { isSafePathSegment, resolveWithinRoot, safeChildPath } from '../../src/core/safePath';

describe('isSafePathSegment', () => {
    it.each([
        'photo.jpg',
        'my-story-abc_123',
        'N_john-smith-1900-london-abcd1234',
        'name with spaces.png',
        '..hidden',
        'a..b',
    ])('accepts %j', (name) => {
        expect(isSafePathSegment(name)).toBe(true);
    });

    it.each([
        '',
        '.',
        '..',
        '../x',
        'a/b',
        'a\\b',
        '..\\x',
        '/etc/passwd',
        'nul\0byte',
    ])('rejects %j', (name) => {
        expect(isSafePathSegment(name)).toBe(false);
    });

    it('rejects non-strings', () => {
        expect(isSafePathSegment(undefined)).toBe(false);
        expect(isSafePathSegment(42)).toBe(false);
    });
});

describe('resolveWithinRoot', () => {
    const root = path.resolve('/data/root');

    it('resolves nested relative paths under the root', () => {
        expect(resolveWithinRoot(root, 'people/a.yaml')).toBe(path.join(root, 'people', 'a.yaml'));
        expect(resolveWithinRoot(root, 'people/../stories/b.md')).toBe(path.join(root, 'stories', 'b.md'));
    });

    it('rejects paths that escape the root', () => {
        expect(() => resolveWithinRoot(root, '../x')).toThrow(/outside/);
        expect(() => resolveWithinRoot(root, 'people/../../x')).toThrow(/outside/);
        expect(() => resolveWithinRoot(root, '/etc/passwd')).toThrow(/outside/);
    });

    it('rejects a sibling directory that shares the root as a prefix', () => {
        expect(() => resolveWithinRoot(root, '../root-evil/x')).toThrow(/outside/);
    });

    it('rejects the root itself', () => {
        expect(() => resolveWithinRoot(root, '.')).toThrow(/outside/);
    });
});

describe('safeChildPath', () => {
    const dir = path.resolve('/data/root/stories');

    it('returns the resolved path of a single-segment child', () => {
        expect(safeChildPath(dir, 'my-story.md')).toBe(path.join(dir, 'my-story.md'));
    });

    it('resolves a relative directory to an absolute path', () => {
        expect(safeChildPath('data/stories', 'a.md')).toBe(path.resolve('data/stories', 'a.md'));
    });

    it.each(['', '.', '..', '../x.md', 'a/b.md', '..\\x.md', '/etc/passwd', 'nul\0.md'])(
        'returns null for %j',
        (name) => {
            expect(safeChildPath(dir, name)).toBeNull();
        },
    );

    it('returns null for non-strings', () => {
        expect(safeChildPath(dir, undefined)).toBeNull();
    });
});
