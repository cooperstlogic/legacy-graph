# LegacyGraph: Remaining Work

> See `SPECIFICATION.md` for the full technical spec.

---

## Completed Phases

| Phase | Description |
|:------|:------------|
| 1–2 | Core Logic: Schemas, GraphEngine, BootLoader, GraphLogic, StoryLoader, TransactionManager, DateParser, HotPatch, Watcher |
| 3.1–3.15 | Search (FlexSearch), GEDCOM Import/Export, Media (Sharp thumbnails), API Server & Auth, Backend Optimizations (worker hydration, tiered cache, slim nodes, search persistence, write dedup), Human-Readable IDs, Fuzzy Date Parsing, Asset Deletion, Place/Geo-tagging (GeoNames DB, forward+reverse geocoding, PlaceSearchCombobox) |
| 4.1–4.22 | Frontend Foundation: App shell, Hydration overlay, Command Palette, People Browse, Person Detail (Holy Grail 3-column), Event & Relationship Editors, Import, Settings, Search Results, SmartDateInput, Notebook, Timeline improvements, Dark/Light mode, Server-side search, E2E tests (Playwright) |
| 4.9 | Dashboard Force Graph: `react-force-graph-2d` with Y-gravity, sex-colored nodes, spouse/parent edges, `GET /api/graph` |
| 5.1 | Stories System: Full CRUD, Milkdown Crepe WYSIWYG, @mention chips, auto-save, story feed with filter/sort |
| 5.4–5.4c | Asset System: Single source of truth (`person.assets[]`), gallery with search/filter/sort, AssetDetailModal, bulk upload with EXIF, PersonSearchCombobox, AssetPickerDialog |
| 5.5 | Dashboard Viz Modes: Fan Chart (360 SVG, Ahnentafel, lineage colors, gen depth 3-6), Pedigree Chart (bidirectional Reingold-Tilford, progressive disclosure, popover/bottom sheet), mode toggle, state persistence |
| TS6 | TypeScript 6 upgrade (typescript ^6.0.2, typescript-eslint ^8.58.0) |
| 5.6 | Batch Geocoding: `searchWithMetadata()` with confidence scoring, `/api/geocoding/batch` + `/apply` endpoints, Settings review dialog with filter/search, site_name extraction from dropped parts, original location preservation in `_gedcom.original_locations` |
| 5.6.1 | Async Batch Geocoding: Background job system (`JobManager` with EventEmitter), SSE progress streaming (`/batch/stream`), server-side result persistence (`_meta/.batch-geocode-results.json`), resumable review sessions (selections saved to server), Zustand store for cross-navigation state, non-blocking UI during scan |
| 5.2.0 | Schema 5.1: event date ranges — `end_date`/`sort_end_date` added to `EventSchema`, `PersonSchema` version bumped with auto-migration from `"5.0"`, `parseDateRange()` utility, GEDCOM Import populates ranges from `BET … AND …` and `FROM … TO …`, EventEditorDialog range toggle, PersonTimeline displays spans |
| 5.2 | Map View (`/map`): bundled offline Natural Earth basemap (no third-party CDN), MapLibre + deck.gl event overlay with zoom-crossfaded embers + heatmap → pins → focal path, dual-handle Radix time slider with step playback, scope filter (Everyone / Focal / Lineage) sharing `useFocalStore`, top-bar collapsible event-type filter popover (doubles as the legend), deep-link contract round-trip, mobile 40 vh drawer with swipe-to-dismiss, LRU(32)-cached `GET /api/map/events` invalidated via `graph-updated`. See `SPECIFICATION.md §6.11`. |
| 5.2.1 | Map View perf + UX overhaul: **GPU time filtering** (`DataFilterExtension` on pins/embers/heatmap via `FilteredHeatmapLayer`, which fixes three upstream deck.gl 9.3 bugs) → scrubbing/playback are uniform-only updates; **live scrub** (rAF-throttled window updates during drag); data-keyed memos (structural sharing survives refetches); pre-parsed event years; pruned `places.json` to renderable ranks (−21%); **step semantics fix** (step = 1/10/100 yr as labeled; seed width stays 5/20/100; playback clamps step to window width); slider redesign (event-count histogram strip, extent labels, centered window readout, real tooltips, focus-aware keyboard guard); `?t/t_end` deep link no longer clobbered by extent seeding; **dynamic range** (ember under-layer + threshold 0.01 + gamma-compressed ramp — sparse events never vanish); **stacked-event picking** (`pickMultipleObjects` → co-located list in drawer); desktop drawer docks right (fixed over-constrained CSS); removed dead ~25 m jitter (sub-pixel at zoom-8 cap). |
| 5.2.2 | Map View zoom-choppiness fix: zooming below zoom 5 dropped ~13 frames per 0.5-zoom step (200–250 ms stalls, GPU-side — no JS long task) while zoom ≥ 5 held a flat 16.7 ms. Two causes, both in `buildMapLayers`: the inline `_subLayerProps` literal made every layer rebuild aggregation-dirty (`"props._subLayerProps changed shallowly"` — it is not in `HeatmapLayer`'s `ignoreProps`), forcing an immediate re-aggregation; and `HeatmapLayer`'s max-weight reduction draws `weightsTextureSize²` vertices that all blend into one texel — 4.19M at the 2048 default. Fixed by hoisting `HEATMAP_SUBLAYER_PROPS` to module scope and setting `weightsTextureSize: 1024`. Measured after: low band mean 26.4 → 17.1 ms, worst frame 250 → 49 ms, aggregations per sweep 6 → 1 (zoom-in) with no dirty-prop churn; heatmap output unchanged. See `SPECIFICATION.md §6.11`. |
| SEC-1 | CodeQL triage (first scan after the org transfer): **path traversal** fixed — story `:id`, asset `:filename` (param + body) and stored asset names must be a single path segment (`src/core/safePath.ts`), and `TransactionManager` rejects writes outside the data dir; previously `..%2F` params or `assets: ["../x"]` could read/overwrite/delete files outside it. **GEDCOM line-parser ReDoS** fixed (quadratic backtracking that also dropped lines containing U+2028; bare-CR terminators now accepted). **Login rate limit** (10/min/IP → `429 RATE_LIMITED`, `@fastify/rate-limit`). Remaining alerts dismissed with reasons (no rate limit on other routes by design; slug-regex, excerpt-sanitizer and JSON "reflected XSS" are false positives). See `SPECIFICATION.md §5` Path Safety. |

---

## Remaining Work

### Known Bugs

- [ ] **API-created people lose `scrapbook_md` on their next edit** (data loss, pre-existing). `GraphEngine.loadHeavyFields()` finds the YAML via `reverseFileMap`, which is only filled at boot or when the watcher re-reads a file. When self-write dedup matches (data dir path identical to the watcher's event path — e.g. an absolute, symlink-free path on Linux), a person created via `POST /api/people` never gets an entry, so the next `PUT` rebuilds it with `scrapbook_md: ''`, and batch geocode apply skips them. Relative `DATA_DIR` (e2e) and macOS `/var` → `/private/var` paths mask it because dedup silently misses. Fix: register the file path on API writes and normalize self-write keys.
- [ ] **`tests/e2e/geocoding.test.ts` fails when run alone** (order dependence, pre-existing): the EXIF-GPS upload test (`geocoding.test.ts:104`) can't find the London location span at line 140, but passes in the full `npm run test:e2e` run. Root cause not yet investigated.

### Phase 5.2 — Map View (`/map`)

Implementation is complete except for the user-flow E2E test. See `SPECIFICATION.md §6.11` for the authoritative spec; this section tracks only what's still open.

- [ ] **5.2.24** — Playwright user-flow E2E (`tests/e2e/map.spec.ts`). **Deferred** until in-flight UX polish settles — writing the suite now would mean rewriting it as the rough edges get fixed. The visual-regression harness (`tests/e2e/map-snapshots.spec.ts`, `npm run test:visual`, 10 baselines across 5 locations × light/dark) already covers basemap rendering.

When this lands, cover: pin click → drawer; URL share round-trip; scope switch with a focal set; event-type filter (uncheck `census` → pin count drops); slider drag → heatmap changes; dark-mode toggle → background color changes. Seed via the existing `setupTestDataDir()` helper with a fixture of ≥3 geocoded events.

Manual smoke test (post-UX-polish): backend on `:3000`, frontend on `:5173`, DevTools → Offline → `/map` shows countries/states/cities/graticules from `localhost` only; toggle dark mode (no relayout flash); set focal on `/`, switch to Lineage scope, drag both slider handles, press Space; click a pin and reload the URL in a new tab; resize < 768 px and swipe the drawer down to dismiss.

### Phase 5.6 — Private Mode & Guest Mode

1. `private?: boolean` on `PersonSchema` (default false). Lock icon toggle in Identity Panel.
2. API middleware: filter `private: true` from list/search when unauthenticated. Return 404 (not 403) for direct access.
3. Frontend: private persons hidden in guest mode. Witness events show "Private Individual".

### Phase 5.7 — Command Palette Commands

1. Static `COMMANDS` array in CommandPalette (Create Person, Import/Export GEDCOM, Switch Theme, Create Snapshot, Force Rebuild, View Map, View Assets).
2. Render as 4th `CommandGroup`, wire actions.

### Phase 5.8 — Git History & Recovery

**Backend:**
1. Semantic commit messages via `OperationHint` in `TransactionManager` (create/update/delete person, upload/delete media, import, story CRUD).
2. `getPendingLabels()`, `setBatchHint()`, `flush(messageOverride)` on TransactionManager.
3. `GET /api/system/git-status` (enhanced: branch, dirty, pendingFiles, lastCommit).
4. `POST /api/system/commit` (flush with optional message).
5. `GET /api/system/git-log` + `GET /api/system/git-log/:hash` (paginated history + commit detail).
6. `GET /api/system/snapshots` + `DELETE /api/system/snapshots/:name`.
7. `POST /api/system/restore` (full-repo or single-person scope).
8. `GET /api/people/:id/history` (path-filtered commit log).
9. Extend `GET /system/status` with heap metrics + hydration duration.

**Frontend:**
10. `useGitStatus()` (adaptive polling), `useGitLog()`, `useGitCommitDetail()`, `useSnapshots()`, `usePersonHistory()`, mutation hooks.
11. Settings page: 4 sections (System Status, Git Status + Commit Now, History Log, Snapshots).
12. `RestoreDialog` component (full-repo + single-person scopes).
13. `PersonHistoryTab` as 4th tab in Person Detail Context Panel.
14. Sidebar dirty indicator (branch name + amber dot).

### Phase 6 — Distribution & Deployment

1. Docker multi-stage build (frontend + backend).
2. Electron desktop wrapper.
3. CI/CD GitHub Action (Vitest + Playwright on PRs).
4. "Living Surname" anonymization (requires Phase 5.6).
5. GEDCOM Export UI (Command Palette trigger).
