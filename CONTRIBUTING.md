# Contributing to LegacyGraph

Thanks for your interest. Issues, bug reports, and pull requests are welcome.

## Before you start

**Licensing.** LegacyGraph is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE), not an OSI open-source licence. Commercial use
is not permitted. By submitting a pull request you agree that your contribution is licensed
under those same terms.

**Open an issue first for anything substantial.** Bug fixes and small improvements can go
straight to a PR. For a new feature, a schema change, or a refactor that moves files around,
open an issue so the design can be settled before you write code — `SPECIFICATION.md` is
authoritative, and a feature usually needs a spec change alongside it.

## Development setup

```bash
git clone https://github.com/cooperstlogic/legacy-graph.git
cd legacy-graph
npm install
cd client && npm install && cd ..
```

Create a `.env` in the repository root:

```bash
DATA_DIR=./data
PORT=3000
```

Then prepare a data directory and populate it with the synthetic generator, so you are never
developing against real family data:

```bash
mkdir -p data/{people,stories,assets}
git init data
npm run generate:synthetic-data -- --count 260 --generations 6 --stories 12 --output ./data
```

Run both halves:

```bash
npm start                    # backend  :3000
cd client && npm run dev     # frontend :5173
```

## The rules

These are not stylistic preferences; they are how the project stays correct.

1. **Tests come first.** Development is test-driven — write the failing test, then the
   implementation. A PR that adds behaviour without a test that would have failed before it
   will be sent back.
2. **The spec is authoritative.** `SPECIFICATION.md` describes the system. Where the code and
   the spec disagree, that is a bug, not a documentation lag. Changing behaviour means changing
   the spec in the same PR.
3. **No flaky tests.** If a test is intermittent, find the root cause — a race, a shared
   temp directory, a missing `await`. Do not retry it, skip it, or raise its timeout to paper
   over the cause. This applies to tests you did not write and that have nothing to do with
   your change.
4. **Keep `PROGRESS.md` current.** Update it when you start or finish a phase of work.

## Before you open a pull request

All four must pass with zero errors:

```bash
npm test                 # backend unit tests (Vitest)
npm run lint             # backend lint
cd client && npm run lint
npm run test:e2e         # Playwright — stop the dev backend first
```

E2E tests start their own backend on `:3000`. If the dev server is running, free the port:

```bash
lsof -ti :3000 | xargs kill
```

Type-checking runs as `npm run build` (`tsc --noEmit`) for the backend and
`cd client && npm run build` for the frontend. CI runs every one of these on your PR.

## Pull request conventions

- **One concern per PR.** A bug fix and a refactor belong in separate pull requests.
- **Branch from `main`**, named for the work: `fix/asset-path-traversal`,
  `feat/gedcom-export`.
- **Write commit subjects in the imperative mood** — "Add residence event span support", not
  "Added" or "Adds". Explain *why* in the body when the reason is not obvious from the diff.
- **Say what you tested.** Which suites you ran, and what you exercised by hand.
- **Never commit your data directory.** `/data/` and `.env` are gitignored; keep them that way.
  Use the synthetic generator for anything you attach to an issue or PR.

## Project layout

`README.md` has an architecture overview and a directory map; `CLAUDE.md` is the short-form
developer guide with the same commands. `SPECIFICATION.md` is the long-form authority on the
data model, the schema, and every endpoint — start there when a question is about *what the
system should do*.

## Reporting bugs and security issues

Bugs: [open an issue](https://github.com/cooperstlogic/legacy-graph/issues/new/choose) with the
version, your platform, what you expected, and what happened.

Security vulnerabilities: **do not** open a public issue — follow [`SECURITY.md`](SECURITY.md).
