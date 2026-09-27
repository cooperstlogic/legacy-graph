import { describe, it, expect } from 'vitest';
import { YAMLException } from 'js-yaml';
import { loadYaml, dumpYaml } from '../../src/core/yaml';

describe('loadYaml', () => {
    it('parses a mapping', () => {
        expect(loadYaml('a: 1\nb: two\n')).toEqual({ a: 1, b: 'two' });
    });

    it('returns undefined for an empty string', () => {
        expect(loadYaml('')).toBeUndefined();
    });

    it('returns undefined for whitespace-only input', () => {
        expect(loadYaml('  \n\n')).toBeUndefined();
    });

    it('returns undefined for comment-only input', () => {
        expect(loadYaml('# nothing here yet\n')).toBeUndefined();
    });

    it('returns null for an explicit null document', () => {
        expect(loadYaml('---\n')).toBeNull();
    });

    it('keeps unquoted dates as strings', () => {
        expect(loadYaml('date: 1990-01-01\n')).toEqual({ date: '1990-01-01' });
    });

    it('throws YAMLException on malformed input', () => {
        expect(() => loadYaml('a: [1, 2\n')).toThrow(YAMLException);
    });

    it('throws YAMLException on multi-document input', () => {
        expect(() => loadYaml('a: 1\n---\nb: 2\n')).toThrow(YAMLException);
    });
});

describe('dumpYaml', () => {
    it('round-trips through loadYaml', () => {
        const value = { id: 'N_x', names: [{ given: 'Ada' }], note: 'x'.repeat(200) };
        expect(loadYaml(dumpYaml(value))).toEqual(value);
    });
});
