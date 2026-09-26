// tests/fixtures/fixtureDataDir.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const FIXTURE_DATA_DIR = path.join(__dirname, 'data');

/**
 * Copy the committed fixture data (tests/fixtures/data: `.gitignore` + `people/`)
 * into a fresh temp dir for one test file, and return its path.
 *
 * Vitest runs test files in parallel. When API test files shared
 * tests/fixtures/data, one file's setup or teardown broke another mid-run:
 * deleting `assets/` (ENOTEMPTY while uploads were in flight), wiping `people/`
 * in GEDCOM replace mode, or writing `_meta/auth.yaml` (sporadic 401s).
 * Remove the returned dir in `afterAll`.
 */
export function createFixtureDataDir(name: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    fs.copyFileSync(path.join(FIXTURE_DATA_DIR, '.gitignore'), path.join(dir, '.gitignore'));
    fs.cpSync(path.join(FIXTURE_DATA_DIR, 'people'), path.join(dir, 'people'), { recursive: true });
    return dir;
}
