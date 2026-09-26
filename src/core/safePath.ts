// src/core/safePath.ts
import * as path from 'path';

/**
 * True if `name` is a single path segment that stays inside the directory it is
 * joined to: non-empty, not `.` or `..`, and free of `/`, `\` and NUL.
 *
 * Route params are URL-decoded (`..%2F` arrives as `../`) and asset names in
 * person/story data are client-supplied, so both must pass this check before
 * they are joined onto a data directory.
 */
export function isSafePathSegment(name: unknown): name is string {
    return typeof name === 'string'
        && name.length > 0
        && name !== '.'
        && name !== '..'
        && !/[/\\\0]/.test(name);
}

/**
 * Resolve `relativePath` against `root` and return the absolute path.
 * Throws if the result is the root itself or lies outside it.
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
    const base = path.resolve(root);
    const target = path.resolve(base, relativePath);
    if (!target.startsWith(base + path.sep)) {
        throw new Error(`Path "${relativePath}" resolves outside ${base}`);
    }
    return target;
}
