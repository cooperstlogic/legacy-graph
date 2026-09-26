import { load, loadAll, dump, YAMLException } from 'js-yaml';

/**
 * Parse a single YAML document. Empty, whitespace-only and comment-only input
 * returns `undefined` (js-yaml 5's `load` throws on it), so callers can keep
 * treating a blank file as "no data" rather than as a parse error.
 */
export function loadYaml(source: string): unknown {
    try {
        return load(source);
    } catch (err) {
        // Only re-parse on the error path so the common case stays a single pass.
        if (err instanceof YAMLException && isEmptyStream(source)) return undefined;
        throw err;
    }
}

function isEmptyStream(source: string): boolean {
    try {
        return loadAll(source).length === 0;
    } catch {
        return false;
    }
}

export const dumpYaml = dump;
