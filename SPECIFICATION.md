# **LegacyGraph: Master Technical Specification (v5.0)**

---

## **1. Executive Summary & Core Axioms**

LegacyGraph is a self-hosted genealogy platform. It rejects proprietary database "lock-in", treating family history as a durable, version-controlled, human-readable file system.

### **1.1 Core Axioms**

1.  **The "Notepad" Rule**: The database **IS** the file system. A user must be able to navigate, read, and understand their entire family history using only a basic text editor (VS Code, Notepad). The application is an _enhancer_, not a gatekeeper.
2.  **Git is the Undo Button**: Every save action in the UI is captured by Git. This is not just backup — it is a first-class, actionable history layer:
    - Every write is debounced into an atomic commit with a **semantic message** (`"Add person: Johann Bach (1685)"`, not `"Update 1 files"`). See Section 7.1.
    - The **commit history is surfaced in the app** as a paginated audit log — browse what changed and when without leaving LegacyGraph.
    - Users can **restore to any point** (full repo or single person) from within the app. Single-person restore creates a safe new forward commit. Full-repo restore uses `git.checkout` and automatically rebuilds the graph. See Section 7.2.
3.  **Event-Sourced Truth**: Relationships (Spouse) are computed from Events (Marriage - Divorce), not stored as static fields.
4.  **Local-First Security**: Authentication is local. No cloud dependencies.
5.  **Data Density**: The UI prioritizes information density over whitespace (VS Code aesthetic).

### **1.2 Rules of Engagement**

*   **Spec First**: Before any code is checked in for subsequent phases of implementation, this spec document must be updated and kept up to date. Discrepancies between Spec and Code are treated as critical bugs.
*   **Test-Driven Design (TDD) IS MANDATORY**: You must write a failing test case before writing any implementation code. This ensures all logic is verifiable and requirements are explicitly understood before coding.
*   **Hybrid Hydration**: We use "Nuclear" hydration (reload all) on boot for safety, accelerated by a **Tiered Cache** (see Section 2.3), and **Granular Hot-Patching** with diff-based edge reconciliation during live updates for sub-100ms feedback.

---

## **2. System Architecture: The "Dual-Head" Pattern**

### **2.1 Head 1: The Source of Truth (Persistence)**

- **Storage**: Local File System.
- **Format**:
  - **Data**: YAML (`/people/*.yaml`) - Structured Person Data.
  - **Narrative**: Markdown (`/stories/*.md`) - Rich text stories/articles.
  - **Media**: Binary (`/assets/*`) - JPG, PNG, WEBP, PDF, MP4.
  - **Meta**: Indices (`/_meta/*.yaml`) - Global configuration and caches.
- **Control**: Hidden `.git` directory managing the entire state.

### **2.2 Head 2: The Experience (Runtime)**

- **Engine**: Node.js (Fastify) + Graphology (In-Memory Graph).
- **Behavior**:
  - **Nuclear Hydration**: On boot, the engine reads **all** files to build the graph in RAM (see 2.3 for scaling strategy).
  - **Hot-Patching**: `@parcel/watcher` watches both `people/` (YAML) and `stories/` (Markdown) directories via native OS APIs (FSEvents on macOS, ReadDirectoryChangesW on Windows, inotify on Linux). Granular handlers (`create`, `update`, `delete`) update/patch specific nodes in <100ms without full reloads. Person edge updates use a **Diff-Based Reconciliation** strategy (see 4.1). Story updates reconcile `mentions` edges and surgically re-index search.
  - **Indexing**: FlexSearch (In-Memory) for full-text search. Loaded from a persistent serialized index on boot when available (see 2.3D), with surgical re-indexing of changed nodes. Incrementally updated during hot-patching. Tracked document IDs use `Set<string>` for O(1) membership checks during hydration and export.
  - **Computed Cache**: Derived relationships (spouses, siblings) are pre-computed and stored as volatile `_computed` attributes on Graphology nodes, invalidated surgically on change events (see 4.1).

### **2.3 Performance Architecture: Tiered Hydration & Scaling**

The Dual-Head pattern is elegant for small to medium datasets but requires deliberate scaling strategies to avoid bottlenecks as the graph grows beyond thousands of nodes.

**A. Tiered Cache Model**

Nuclear Hydration (parsing and Zod-validating every YAML on boot) scales linearly with dataset size. For large datasets (10,000+ people), this blocks the Node.js event loop and delays startup.

- **Binary Cache**: An intermediate serialized cache (JSON blob at `/_meta/.graph-cache.json`) sits between YAML files and the Graphology runtime. On boot, the engine checks if the cache exists and is fresh.
- **Incremental Rebuild**: The cache stores the `mtime` (last modified time) of every source YAML file. On boot, only files whose `mtime` is newer than the cached entry are re-parsed from YAML. All other nodes load directly from the pre-validated cache.
- **Cache Invalidation**: The cache is considered stale and triggers full Nuclear Hydration when: (a) the cache file is missing, (b) the `spec_version` in the cache header does not match the current schema version, or (c) the user explicitly requests a full rebuild via the API.

**B. Memory Budget & Scaling Ceiling (Slim Node Strategy)**

Graphology and FlexSearch run entirely in memory. While 10,000 nodes is trivial (~50MB), 100,000 nodes with rich Markdown scrapbooks and extensive FlexSearch indices can push Node.js toward the default V8 heap limit (~1.5–2GB). If 50,000 users have 2KB of markdown notes each, that is ~100MB of raw text sitting idle in the V8 heap until a detail page is opened.

- **Slim Node Principle**: The in-memory Graphology runtime stores **only the fields required for graph traversal, search indexing, and computed relationships**. Heavy payload fields — `scrapbook_md` (free-form Markdown) and `_gedcom` (loss-prevention data) — are **stripped from the in-memory `data` attribute** during hydration and hot-patching. This applies to both the Graphology node and the binary cache.
- **Lazy Loading**: When `GET /api/people/:id` is called, the server reads the source YAML file from disk to retrieve `scrapbook_md` and `_gedcom`, then merges them into the response. This is a single async `fs.readFile` + YAML parse — negligible latency for a detail-page request, but it keeps ~100MB+ of idle text out of the V8 heap.
- **What Stays In Memory**: `id`, `version`, `created`, `last_modified`, `names`, `sex`, `tags`, `relationships`, `events`, `assets`, and the volatile `_computed` cache. These fields are sufficient for graph traversal, edge reconciliation, search indexing, timeline slicing, and computed relationship derivation.
- **Monitoring**: `GET /system/status` should be extended (Phase 5+) to expose `heapUsedMB` from `process.memoryUsage()` so operators can monitor runtime memory consumption.
- **Scaling Ceiling**: With the Slim Node Strategy, the architecture comfortably serves datasets up to ~100,000 nodes within default V8 memory. Beyond that, further evolution (LRU eviction of event arrays, graph partitioning) would be needed — but this is well beyond typical genealogy datasets.

**C. Worker Thread Hydration**

Hydration is offloaded from the main event loop via `worker_threads`, allowing the Fastify server to start immediately and serve health checks while data is being loaded. This applies to **all** dataset sizes — even for modest datasets it ensures the server is never unresponsive during startup.

- **Strategy**: Use Node.js `worker_threads` to perform YAML parsing, Zod validation, and story loading in a background thread. The main thread remains responsive and serves `GET /system/status` with `hydrationState: "loading"` to clients.
- **503 During Loading**: While hydration is in progress, all API endpoints except `GET /system/status`, `GET /system/hydration/stream`, and auth endpoints (`POST /auth/login`, `POST /auth/logout`) return `503 Service Unavailable` with `{ error: "Graph is loading", code: "HYDRATION_IN_PROGRESS" }`.
- **Cache-Aware**: The worker performs the tiered cache comparison (Section 2.3A) internally — only stale files are re-parsed from YAML. Both full nuclear and incremental paths run inside the worker.
- **Handoff**: The worker serializes the validated node map, story list, and mtime entries back to the main thread via `postMessage` (structured clone). The main thread then performs the final Graphology graph construction, edge building, search indexing, and `_computed` relationship computation (which is fast, as it's just inserting pre-validated data).
- **Progress Reporting**: The worker emits `{ type: 'progress', phase, loaded, total, percent }` events via `parentPort.postMessage()` during file processing (every 50 files). The `GraphEngine` (which extends `EventEmitter`) relays these as `hydration:progress` events, emitting `hydration:complete` with `{ nodeCount, edgeCount, elapsedMs }` when finished. This feeds the SSE endpoint (`GET /system/hydration/stream`) for frontend progress display.
- **Fallback**: If the worker thread fails (e.g., crash, unhandled error), the engine automatically falls back to inline hydration on the main thread to guarantee startup.
- **Scope**: Worker Thread hydration is the **default boot strategy** (`hydrateInBackground()`). The inline `hydrate()` method is retained as a synchronous alternative for testing and simple usage. The BootLoader logic remains identical; only its execution context changes.

**D. Search Index Persistence**

FlexSearch indices are fully rebuilt from the graph during hydration. While the worker thread and `mtime` cache bypass YAML parsing, tokenizing and building a FlexSearch index for 50,000+ nodes on every boot is heavy CPU work that adds avoidable startup latency.

- **Serialization**: FlexSearch supports exporting and importing its compiled index. After hydration completes (and after any incremental hot-patch), the `SearchService` serializes its person index, story index, and place map to disk at `/_meta/.search-index.json`.
- **Incremental Boot**: On startup, if `/_meta/.search-index.json` exists and its `spec_version` matches the current schema version, the `SearchService` imports the pre-compiled index directly. Only nodes whose `mtime` changed (as determined by the tiered cache comparison in Section 2.3A) are surgically re-indexed — removed from the loaded index and re-added with fresh data.
- **Cache Invalidation**: The search index cache is invalidated (full rebuild triggered) when: (a) the file is missing, (b) `spec_version` mismatches, (c) JSON is corrupt, or (d) the user triggers `POST /system/rebuild`.
- **Storage Format**: `{ spec_version: string, exportedAt: string, personIndex: FlexSearchExport, storyIndex: FlexSearchExport, placeMap: Array<[string, string[]]> }`.
- **Hot-Patch Persistence**: After incremental hot-patch updates to the index (via `indexPerson()` / `removePerson()`), the updated index is re-serialized to disk on a debounced timer (same cadence as the graph cache write) to keep the on-disk index fresh without excessive I/O.

---

## **3. Data Layer Specification**

All data ingestion must pass strict Zod schemas. This ensures data integrity before it enters the runtime graph.

### **3.1 Person Schema (`/people/*.yaml`)**

**File Naming**: `[id].yaml` — the filename always mirrors the record's `id` field.

**ID Format**: Human-readable, globally unique. Structure: `N_[first]-[last]-[birthyear]-[place]-[nanoid8]`

- Example: `N_Johann-Bach-1685-Eisenach-7x9aZ2Kp.yaml`
- Components derived from the person's primary name, birth event year, and birth event location at creation time.
- Slugified: lowercase, spaces → hyphens, diacritics stripped (NFD normalization), non-alphanumeric removed. Variable prefix truncated to 24 chars.
- Components are optional — if unavailable, omitted. Minimum: `N_[nanoid8]`.
- The 8-character nanoid suffix guarantees global uniqueness even when two people share identical name and birth details.
- Old `N_[nanoid]`-format IDs remain valid (no forced migration).

**Auto-ID for Externally Dropped Files**: When the file watcher detects a new `.yaml` file missing the `id` field:
1. Parse and validate the file against a relaxed `PersonSchema` (allowing absent `id`).
2. Generate a new human-readable ID from available name + birth data.
3. Write the `id` field into the YAML in-place (at the top of the document).
4. Rename the file to `[new-id].yaml`.
5. Register both the old and new file paths in the write-origin set to suppress redundant hot-patch events.
6. Proceed with normal hot-patch processing for the renamed file.

| Field           | Type          | Description                                          |
| :-------------- | :------------ | :--------------------------------------------------- |
| `version`       | Literal "5.1" | Schema version for migration safety. Legacy `"5.0"` files are auto-upgraded on read; new fields (`end_date`, `sort_end_date`) default to empty/null. |
| `id`            | String        | Human-readable unique ID. Format: `N_[first]-[last]-[birthyear]-[place]-[nanoid8]`. |
| `created`       | ISO-8601      | Timestamp of creation.                               |
| `last_modified` | ISO-8601      | Timestamp of last edit.                              |
| `names`         | Array         | List of name objects.                                |
| `sex`           | Enum          | `M`, `F`, `I` (Intersex), `U` (Unknown).             |
| `tags`          | Array<String> | User-defined tags (e.g., "Civil War", "Immigrant").  |
| `private`       | Boolean       | If `true`, profile is hidden/anonymized in Guest Mode (see Section 6.14). |
| `relationships` | Object        | Stores **ONLY** upstream parents.                    |
| `events`        | Array         | Chronological life events (See 3.2).                 |
| `assets`        | Array<String> | Filenames of associated media. First item is Avatar. |
| `scrapbook_md`  | String        | Free-form Markdown for unstructured notes/scrapbook. |
| `_gedcom`       | Object        | Preserved unmapped tags from GEDCOM import.          |

**Detailed Schema Definition (Zod Notation):**

```typescript
{
  names: [{
    first: string,
    last: string,
    nickname?: string,
    primary?: boolean
  }],
  relationships: {
    parents: [{
      id: string, // Reference to Person ID
      type: "biological" | "adopted" | "step" | "foster"
    }]
  }
}
```

### **3.2 Event Architecture**

Events are typed objects acting as state reducers. They determine the "current status" of a person (especially for marriages).

**Base Event Fields**:

- `id`: String (NanoID).
- `date`: String (Fuzzy, e.g., "Bet. 1900 and 1910").
- `sort_date`: String (ISO-8601 strict: `YYYY-MM-DD`). Used for chronological ordering.
- `end_date`: String (Fuzzy, e.g., "1920"). Empty when the event is a point in time. Populated for spans like residence, occupation, military service.
- `sort_end_date`: String (ISO-8601) | null. End of range for span events. Must be ≥ `sort_date`. GEDCOM `BET … AND …` and `FROM … TO …` populate this on import; otherwise null.
- `location`: Place Object (Optional). See Section 3.4. Backward-compatible: bare strings are auto-coerced to `{ name: string }` at parse time.
- `description`: String (Markdown supported, Optional).
- `assets`: Array<String> (Filenames).

**Supported Event Types**:

| Type               | Computed Logic / Extra Fields                                                         |
| :----------------- | :------------------------------------------------------------------------------------ |
| `birth`            | Defines start of timeline.                                                            |
| `death`            | Defines end of timeline. Field: `cause` (string).                                     |
| `marriage`         | Links two people. Fields: `partner_id` (string), `status` (married/divorced/widowed). |
| `divorce`          | Terminates a marriage. Field: `partner_id` (string).                                  |
| `engagement`       | Pre-marriage partnership. Field: `partner_id` (string).                               |
| `residence`        | Location history.                                                                     |
| `census`           | Census record. Field: `household_id` (string).                                        |
| `occupation`       | Work history. Fields: `title`, `organization`.                                        |
| `education`        | Academic history. Fields: `institution`, `degree`.                                    |
| `military_service` | Military service record. Fields: `branch`, `rank`.                                    |
| `immigration`      | Immigration record. Location is the destination.                                      |
| `emigration`       | Emigration record. Location is the origin.                                            |
| `adoption`         | Adoption event.                                                                       |
| `baptism`          | Religious event.                                                                      |
| `burial`           | Final resting place.                                                                  |
| `generic`          | Custom events. Field: `title`.                                                        |

### **3.3 Asset Metadata (`/_meta/assets.yaml`)**

Metadata cache for binary assets, indexed by filename.

- **Structure**: Map of `Filename -> Metadata`.
- **Metadata**:
  - `id`: NanoID.
  - `description`: String. (Legacy `caption` fields auto-migrated via Zod `.transform()`.)
  - `date_taken`: ISO-8601.
  - `location`: String.
  - `type`: `image | video | pdf`.
- **Single source of truth**: Person-asset associations live exclusively in `person.assets[]`. The asset metadata index does **not** track `tagged_people` — that field was removed in Phase 5.4b.

### **3.4 Place Schema & Geo-tagging**

Event locations are structured objects rather than freeform strings, enabling map visualization, validated place names, and historical name resolution.

**Place Object** (Zod schema in `src/schemas/EventSchema.ts`):

```typescript
{
  name: string;            // Display name (user's original input or modern equivalent)
  historicalName?: string; // Original historical name if name was resolved to modern form
  lat?: number;            // WGS84 latitude (-90 to +90)
  lng?: number;            // WGS84 longitude (-180 to +180)
  countryCode?: string;    // ISO 3166-1 alpha-2 (e.g., "DE", "GB")
  resolvedAt?: string;     // ISO-8601 timestamp of last successful geocode resolution
}
```

**Backward Compatibility**: During hydration, bare string `location` fields are transparently coerced to `{ name: locationString }` in memory. No YAML rewrite is performed — migration is lossless and silent.

**Geocoding Service** (`src/core/GeocodingService.ts`):

- **Provider**: Offline GeoNames SQLite database (`~/.legacy-graph/geonames.db`). Built via `npm run geonames:build`. No network calls at runtime.
- **GeonamesDb** (`src/core/GeonamesDb.ts`): Read-only SQLite wrapper. Forward search via FTS5 (`searchByName`, `searchFiltered`). Reverse geocoding via spatial index (`reverseGeocode` — two-tier radius, cosine-corrected distance).
- **Caching**: Results cached in `/_meta/.geocode-cache.json` (keyed by normalized place name) to avoid redundant DB queries across sessions. In-memory cache layer on top.
- **Fallback**: If DB is missing or place not found, the Place object is stored with only `name` populated.
- **`resolve(name: string): Promise<Place>`**: Primary public method. Returns cached result if available, otherwise queries GeonamesDb.
- **`search(query: string): Promise<Place[]>`**: Type-ahead search. Parses comma-separated qualifiers for genealogy-style place strings (e.g., "Mountain, Grizzly Flats, CA").
- **`reverseGeocode(lat, lng): Place | null`**: Spatial lookup for EXIF GPS coordinates. Used by `reverseGeocodeExifGps()` in `src/core/assetMetaUtils.ts` during asset uploads.
- **Graceful degradation**: If DB is missing, search returns empty, reverse geocode returns null. No errors thrown.

**New API Endpoints**:

- `GET /api/places/search?q=...` — Returns top 5 geocoded Place candidates for a query string. Used for type-ahead autocomplete in the Event Editor location field.
- `POST /api/places/resolve` — Body: `{ name: string }`. Resolves and caches a specific place. Returns the Place object.

---

## **4. Core Logic & Algorithms (The Brain)**

### **4.0 BootLoader & Integrity**

- **Responsibility**: Loads YAML files from disk.
- **Validation**:
  - **Schema**: Validates against Zod Schemas.
  - **Asset Integrity**: Verifies existence of files referenced in `assets` array. Logs warnings for missing files.

### **4.1 The Graph Engine (Runtime)**

- **Library**: `graphology`.
- **Graph Type**: Directed MultiGraph.
- **Nodes**: `Person`, `Story`.
- **Edges**:
  - `child_of`: From Person -> Parent.
  - `mentions`: From Story -> Person.

**Computed Relationships (Runtime)**:
These are **NOT** stored in YAML. They are derived via graph traversal and cached in volatile `_computed` node attributes.

1.  **Siblings**: `getSiblings(id)`.
    - Logic: Find parents -> Find all children of parents -> Filter `self`.
2.  **Spouses**: `getCurrentSpouse(id)`.
    - **"Henry VIII Algorithm"**:
      1.  Fetch all `marriage`, `divorce` events for Person.
      2.  Sort by `sort_date`.
      3.  Replay timeline: Marriage sets `current_spouse`, Divorce clears it.
      4.  Final check: If `current_spouse` exists, check their `death` events. If dead -> Status `widowed`.

**Graph-Level Memoization (`_computed` Cache)**:

Executing the Henry VIII traversal and sibling lookups on every API request degrades read performance. Instead, computed relationships are pre-calculated and cached:

- **Storage**: Each Graphology node carries a volatile `_computed` attribute (never serialized to YAML or the binary cache). Structure:
  ```typescript
  _computed: {
    currentSpouse: { id: string; status: "married" | "widowed" } | null;
    siblings: string[];     // Array of Person IDs
    children: string[];     // Array of Person IDs (reverse lookup)
    allSpouses: Array<{ id: string; status: string; sortDate: string }>;
  }
  ```
- **Population**: `_computed` is populated during hydration, immediately after all nodes and edges are loaded. The `GraphLogic` module exposes a `computeRelationships(nodeId)` function that writes results directly to the node attributes.
- **Invalidation**: When a file-watcher change event fires for a node, the engine recomputes `_computed` for **that node AND all immediate neighbors** (parents, children, spouses). This ensures a marriage event added to Person A also updates Person B's `_computed.currentSpouse`.
- **API Reads**: API endpoints read directly from `_computed` — no traversal at request time. This turns O(n) graph walks into O(1) attribute lookups.

**Diff-Based Edge Reconciliation (Hot-Patching)**:

The current hot-patching approach drops all outgoing edges and rebuilds them, which is imprecise and can miss stale incoming edges from neighbors.

- **Strategy**: When a YAML file changes, the engine compares the **old** parsed state (retained in memory from the previous hydration) against the **new** parsed state.
- **Reconciliation Steps**:
  1.  **Diff `relationships.parents`**: Compute the set difference between old and new parent IDs. Remove edges for dropped parents; add edges for new parents.
- **Neighbor Cascade**: After reconciling edges for the changed node, trigger `_computed` invalidation (see above) for all affected neighbors.
- **Fallback**: If the diff produces an inconsistent state (e.g., orphaned edges detected), fall back to a targeted "mini-hydration" that drops and rebuilds all edges for the affected node and its immediate neighborhood.

**Unified Write Side-Effects (`applyWriteSideEffects`)**:

All mutation paths — API write handlers and file watcher hot-patching — converge on a single `GraphEngine.applyWriteSideEffects(id, oldSlim, newSlim, bio)` method. This ensures consistency regardless of how a person is created or modified:

1.  **Edge Reconciliation**: If `oldSlim` is non-null, runs diff-based edge reconciliation (see above). If null (new node), adds all parent edges.
2.  **Search Indexing**: Calls `searchService.indexPerson(newSlim, bio)`.
3.  **`_computed` Invalidation**: Calls `invalidateComputed(graph, id)` for the node and all its neighbors.

The file watcher's `handleFileUpdate()` parses the YAML, updates the graph node, then calls `applyWriteSideEffects()`. API handlers (`POST /people`, `PUT /people/:id`) do the same after writing to disk. This eliminates the previous inconsistency where API-created persons were invisible to search and had no computed relationships.

**Story Hot-Patching**:

The file watcher monitors `stories/` for Markdown changes in addition to `people/` for YAML. Story handlers mirror the person hot-patch pipeline:

- **`handleStoryUpdate(filePath)`**: Parses the Markdown file (frontmatter via `gray-matter`, mentions via remark AST walk for `@N_xxx` and `[[N_xxx]]` patterns), adds/updates the story node in the graph (type: `story`), reconciles `mentions` edges to referenced persons, indexes in search via `indexStory()`, and invalidates `_computed` for mentioned persons (timeline changes).
- **`handleStoryRemove(filePath)`**: Drops the story node and all its edges from the graph, removes from the search index, and invalidates `_computed` for previously-mentioned persons.
- **Self-Write Dedup**: Story handlers also check the write-origin set, future-proofing for API-initiated story writes (Phase 5.1).

**Write-Event Deduplication (Self-Write Ignore)**:

When the API writes a file to disk (via `TransactionManager.writeFile()`), the `@parcel/watcher` file watcher detects the change and triggers the hot-patch handler, causing the engine to diff and reconcile edges for an update *it just made*. This is wasted CPU and can cause subtle race conditions during rapid edits.

- **Mechanism**: The `GraphEngine` maintains a transient **write-origin set** (`Set<string>`) of file paths that were written by the application itself (not by an external editor). When `TransactionManager.writeFile()` completes a disk write, it registers the absolute file path with the `GraphEngine`'s write-origin set.
- **Watcher Check**: When the file watcher fires an event, the hot-patch handler checks the write-origin set first. If the file path is present, the event is **consumed** (removed from the set) and the hot-patch is skipped — the graph is already up-to-date from the API handler that initiated the write.
- **External Edits Pass Through**: Changes made by a user editing YAML/Markdown in VS Code, or by `git checkout`, are not registered in the write-origin set and are processed normally by the hot-patch pipeline.
- **TTL Safety**: Entries in the write-origin set expire after 10 seconds to prevent memory leaks if a watcher event is lost or delayed. The TTL is conservative — `@parcel/watcher` typically fires within milliseconds.
- **File Watcher Circuit Breaker**: If the watcher fires a massive localized burst of events (e.g., >50 events in 500ms from `git checkout` or bulk find-and-replace), this indicates a "Massive External Edit". In this state, granular hot-patching is **suspended**. The system transitions `hydrationState` to `"loading"`, ignores further burst events, and triggers a background re-hydration (`hydrateInBackground()`) to rebuild the graph and caches cleanly without starving the Node.js event loop.

### **4.2 Timeline Slicer**

Pre-computes the "Integrated Feed" for the UI Person Detail page.

- **Input**: Person ID, optional pagination params (`limit`, `offset`).
- **Process**:
  1.  **Collection**: Merge Person Events + Story Mentions (Stories mentioning this person).
  2.  **Partition**: Split items into `datedItems` (have `sort_date`) and `undatedItems` (no `sort_date`).
  3.  **Sort dated items**: Strict sort by `sort_date` ascending.
  4.  **Gap Detection**: Iterate sorted dated list. If `Item[i+1].year - Item[i].year > 10`, insert a `Gap` object: `{ type: 'gap', years: diff }`.
  5.  **Assemble**: If any undated items exist, prepend `{ type: 'unknown_date_header' }` followed by all undated items before the dated+gap stream. This ensures undated events are visible at the top, not lost at the bottom.
  6.  **Pagination**: Apply `offset` and `limit` to the final combined array. Return `totalCount` alongside the page slice.
- **Output**: `{ items: Array<Event | Story | Gap | UnknownDateHeader>, totalCount: number, offset: number, limit: number }`.
- **`UnknownDateHeader`**: `{ type: 'unknown_date_header' }` — rendered as a section divider "Undated Events" in the UI.

### **4.3 GEDCOM Engine**

- **Logic**:
  - **Import**: Stream Read -> Parse 5.5.1/7.0 -> Map Tags to Legacy Schemas -> Write YAMLs.
  - **Robustness Rules**:
    - **Date Parsing**: **MUST** use the shared `DateParser` utility (`src/utils/DateParser.ts`). Supports standard formats (`DD MMM YYYY`, `MMM YYYY`, `YYYY`) and modifiers (`ABT`, `EST`, `CAL`, `BEF`, `AFT`, `BET`, `FROM`/`TO`). Invalid dates fallback to standard ISO default.
    - **Relationships**: Must fully reconstruct parent-child links AND spouse links.
      - Iterate `FAM` records.
      - Map `HUSB` -> Father, `WIFE` -> Mother.
      - Iterate `CHIL` children.
      - Update Child's `relationships.parents` array with Father and Mother IDs.
      - **Spouse Linking**: When a `FAM` record contains both `HUSB` and `WIFE`, marriage events **must** be created on both persons regardless of whether a `MARR` sub-record is present. If no marriage date/place is available, create the event with `date: ""` and `sort_date: ""`. Never silently drop a spouse relationship because the marriage record lacks date information.
  - **Export**: Walk Graph -> Serialize to strict GEDCOM format.
  - **Loss Prevention**: Unhandled tags go into `Person._gedcom`.

---

## **5. API Specification (Head 2 Server)**

**Framework**: Fastify (plugin-based route architecture).
**Base URL**: `/api`.
**Errors**: Standard JSON: `{ error: string, code: string, details?: any }`.
**Path Safety**: Any client-supplied value that becomes a file name under the data directory — story `:id`, asset `:filename` (route param or request body), and asset names read from `person.assets[]` or story frontmatter `assets` — must be a single path segment: non-empty, not `.` or `..`, and free of `/`, `\` and NUL. Route params are URL-decoded, so `..%2F` counts as `../`. Unsafe route params return the endpoint's usual `404` (`STORY_NOT_FOUND` / `ASSET_NOT_FOUND`); an unsafe body `filename` returns `400 VALIDATION_ERROR`; unsafe stored asset names are never unlinked. As defense in depth, `TransactionManager` rejects any write, track or remove whose path resolves outside the data directory.

**Route Plugin Architecture**: The server is decomposed into Fastify route plugins (`src/api/routes/`): `people.ts`, `stories.ts`, `assets.ts`, `system.ts`, `search.ts`, `auth.ts`, `gedcom.ts`. Shared services (`GraphEngine`, `TransactionManager`, `AuthConfig`) are bound to the Fastify instance via `server.decorate('appServices', ...)` — eliminating module-level singletons and ensuring clean lifecycle management across test runs. The server orchestrator (`server.ts`) handles only plugin registration, Fastify decoration, and lifecycle hooks (~95 lines).

### **5.1 Entity Endpoints**

- `GET /api/people`: Returns a paginated list of all people (`SlimPersonSummary[]`).
  - **Query**: `?limit=50&offset=0&sort=last_modified&order=desc`.
- `GET /api/people/:id`: Returns hydrated Person object (Schema Data + Computed Relations + Timeline).
  - **Query**: `?timeline_limit=50&timeline_offset=0` (optional, paginates the embedded timeline).
  - **Lazy Loading**: The `scrapbook_md` and `_gedcom` fields are **not** held in the in-memory graph (see Section 2.3B Slim Node Strategy). When this endpoint is called, the server reads the source YAML file from disk asynchronously, extracts these fields, and merges them into the response alongside the in-memory graph data and `_computed` relationships. This adds negligible latency (~1-5ms for a single file read) while keeping the V8 heap lean.
  - _404_: Person not found.
- `POST /people`: Create new Person.
  - _Body_: Partial Person Schema.
  - _Effect_: Writes new YAML, adds node to graph, applies full write-path side effects (parent edges, search indexing, `_computed` invalidation via `applyWriteSideEffects()`), returns ID. Enqueues change to debounced commit queue (see Section 7.1).
- `PUT /people/:id`: Update Person.
  - _Body_: Replacement Person Schema.
  - _Effect_: Captures old slim data for edge diff, overwrites YAML, applies full write-path side effects (edge reconciliation, search re-indexing, `_computed` invalidation for node + neighbors). Enqueues change to debounced commit queue (see Section 7.1).
- `PUT /people/:id/media`: Upload asset.
  - _Multipart_: File data.
  - _Effect_: Saves to `/assets`, updates Person YAML `assets` array, invalidates `_computed` for the person.
- `DELETE /people/:id/media/:filename`: Delete asset.
  - _Effect_: Verifies person exists and filename is in `assets[]`. Deletes binary from `/assets/[filename]` (and thumbnail from cache if present). Removes filename from Person YAML `assets[]`, runs `applyWriteSideEffects()`. Returns `204 No Content`.
  - _404_: Person not found, or filename not in person's `assets[]` array.
- `GET /assets/*`: Static Asset Delivery.
  - _Effect_: Serves files from the `/assets` directory. Uses HTTP Range requests for optimal media streaming (MP4) and injects strong caching headers (`Cache-Control: max-age=31536000, immutable`) powered by ETag/mtime comparisons to prevent Node event loop blocking.

### **5.2 Search & Discovery**

- `GET /places/search`:
  - **Query**: `?q=string`.
  - **Returns**: Array of up to 5 geocoded `Place` candidates for type-ahead autocomplete. Each: `{ name, historicalName?, lat, lng, countryCode }`.
  - **Engine**: Proxies to `GeocodingService.search()` with caching.
- `POST /places/resolve`:
  - **Body**: `{ name: string }`.
  - **Returns**: Resolved `Place` object (geocoded if possible, `{ name }` fallback).

- `GET /search`:
  - **Query**: `?q=string&limit=50&offset=0`.
  - **Params**:
    - `q` (required): Search query string.
    - `limit` (optional, default `50`, max `200`): Maximum results per category.
    - `offset` (optional, default `0`): Pagination offset per category.
  - **Engine**: FlexSearch.
  - **Returns**: `{ people: [], stories: [], places: [], totalCounts: { people: number, stories: number, places: number } }`.

### **5.3 System Operations**

- `POST /system/snapshot`: Flush pending commits, create a Git Tag.
  - _Body_: `{ name: string, description?: string }`.
- `GET /system/snapshots`: List all snapshot tags. See Section 7.2.
- `DELETE /system/snapshots/:name`: Delete a snapshot tag. Auth required. See Section 7.2.
- `GET /system/git-status`: Git status including pending file list. See Section 7.2.
- `POST /system/commit`: Flush pending writes immediately; optional message override. See Section 7.2.
- `GET /system/git-log`: Paginated commit history. See Section 7.2.
- `GET /system/git-log/:hash`: Single commit detail with file diffs. See Section 7.2.
- `POST /system/restore`: Full-repo or single-person restore. See Section 7.2.
- `POST /import/gedcom`: Bulk Import.
  - _Warning_: Destructive. Wipes current data directory (except `.git`).
- `GET /api/stats`: Returns dashboard statistics (`totalPeople`, `totalFamilies`, `lastModified`).
- `GET /system/status`: Returns runtime health info. **Always available**, even during hydration (see 2.3C).
  - _Returns_: `{ nodeCount: number, edgeCount: number, hydrationState: "ready" | "loading", cacheAge: string | null }`.
  - _Note_: When `hydrationState` is `"loading"`, `nodeCount` and `edgeCount` are `0` until hydration completes.
- `GET /system/hydration/stream`: Server-Sent Events (SSE) stream of hydration progress. **Always available**.
  - _Content-Type_: `text/event-stream`.
  - _Events_: `{ event: "progress", data: { phase: string, loaded: number, total: number, percent: number } }`, `{ event: "complete", data: { nodeCount: number, edgeCount: number, elapsedMs: number } }`, `{ event: "error", data: { message: string } }`.
  - _Behavior_: If hydration is already complete when the client connects, immediately sends a `complete` event and closes. During loading, streams periodic `progress` events as the worker processes files, followed by a final `complete` event.
- `POST /system/rebuild`: Force a full Nuclear Hydration, bypassing the tiered cache.
  - _Effect_: Invalidates `/_meta/.graph-cache.json`, re-parses all YAML files, rebuilds graph and search index from scratch.

### **5.4 Authentication**

- `POST /auth/login`: Authenticate user.
  - _Body_: `{ username: string, password: string }`.
  - _Effect_: Validates against `/_meta/auth.yaml` (BCrypt). Returns JWT in HttpOnly Cookie.
  - _401_: Invalid credentials.
  - _429_: More than 10 attempts from one client IP within a minute (successful or not): `{ error, code: "RATE_LIMITED" }`. Keyed per IP, so one attacker cannot lock other users out.
- `POST /auth/logout`: End session.
  - _Effect_: Clears HttpOnly Cookie.
- **Auth Guard**: All endpoints except `POST /auth/login`, `GET /system/status`, and `GET /system/hydration/stream` require a valid JWT.
- **Rate Limiting**: LegacyGraph must work as a shared, multi-user instance, so every API endpoint is rate-limited: 600 requests per minute by default (`RATE_LIMIT_MAX`), keyed by authenticated username, or by client IP when unauthenticated. Exceeding it returns `429 { error, code: "RATE_LIMITED" }`. Static delivery under `/assets/` is exempt. Behind a reverse proxy, `TRUST_PROXY` (Fastify `trustProxy`: `true`, a hop count, or trusted addresses) must be set so the client IP is the real client rather than the proxy.

---

## **6. User Experience (UI) Specification**

### **6.1 Architecture & Tooling**

- **Location**: `client/` directory within the monorepo. Separate Vite config, built independently. Production build output served by Fastify via `@fastify/static`.
- **Framework**: Vite + React 19 + TypeScript.
- **Routing**: TanStack Router (file-based routes).
- **Data Fetching**: TanStack Query — **all** API calls go through Query hooks with optimistic update wrappers from day one. Mutations use `onMutate` → optimistic cache update, `onError` → rollback, `onSettled` → invalidate.
- **UI State**: Zustand for UI-local state (sidebar collapsed, active panel, modal visibility, active tab). Keeps component tree clean; avoids prop-drilling and excessive Context providers.
- **Component Library**: shadcn/ui (Radix primitives + Tailwind CSS). Provides accessible, unstyled-by-default components with full style control. Import components as needed — no monolithic bundle.
- **CSS**: Tailwind CSS v4 with Dark Mode palette (Slate/Zinc/Neutral base). Custom design tokens for spacing, color, and typography via `tailwind.config.ts`.
- **Typography**: `Inter` (UI chrome), `Fira Code` (data fields, IDs, dates), `Merriweather` (story narrative content). Loaded via Google Fonts or self-hosted WOFF2.
- **Icons**: Lucide React (consistent, tree-shakeable icon set used by shadcn/ui).

### **6.2 Layout Strategy**

#### **6.2.1 Theme**

- **Dark and Light Mode**: Dark mode is the default (high contrast, Slate/Zinc/Neutral base palette). A **light/dark toggle** must be present in the TopBar (or Settings page). Both themes must be visually polished and consistent — not just a color inversion. Theme preference is persisted in `localStorage`. All color tokens are CSS custom properties (e.g., `--background`, `--foreground`, `--muted`, etc.) scoped to `[data-theme="dark"]` and `[data-theme="light"]` selectors on `<html>`. Switching themes requires only toggling the `data-theme` attribute.
- **Design Language**: Clean, professional, data-dense. Think VS Code meets Grafana — no decoration for its own sake, no heritage textures. Every pixel serves information.

#### **6.2.2 App Shell**

```
┌─────────────────────────────────────────────────────┐
│  [Sidebar]  │              [Top Bar]                │
│             │  ┌──────────────────────────────────┐  │
│  Dashboard  │  │                                  │  │
│  People     │  │         [Page Content]           │  │
│  Import     │  │                                  │  │
│  Settings   │  │                                  │  │
│             │  └──────────────────────────────────┘  │
│  [Status]   │                                       │
└─────────────────────────────────────────────────────┘
```

- **Persistent Left Sidebar** (VS Code Activity Bar pattern):
  - Icons + labels for: **Dashboard** (Tree), **People** (Users), **Stories** (Book), **Map** (Globe), **Assets** (Image), **Import** (Upload), **Settings** (Cog).
  - System status indicator at bottom (node count, hydration state dot — green/amber/red).
  - **Settings entry** additionally shows: current Git branch name (muted monospace, max 16 chars) + amber `•` dot when `gitDirty: true`. In icon-only mode: amber dot badge on the gear icon. See Section 6.12.
  - Collapsible to icon-only mode via toggle button or responsive breakpoint.
- **Top Bar**:
  - Breadcrumb trail (e.g., `People / John Smith`).
  - **Cmd+K** search trigger button (magnifying glass icon + hotkey hint).
  - User avatar / logout button (when auth is active).
- **Responsive Behavior**:
  - `≥1280px`: Full sidebar with labels + page content.
  - `768px–1279px`: Icon-only sidebar (labels hidden), full page content.
  - `<768px`: Sidebar collapses to hamburger menu overlay. Single-column page layout.

#### **6.2.3 Route Structure**

| Route | Page | Description |
|:------|:-----|:------------|
| `/` | Dashboard | Stats panel, visualization modes (Force Graph / Fan Chart / Pedigree) |
| `/people` | People Browse | Searchable/filterable list of all people |
| `/people/:id` | Person Detail | "Holy Grail" 3-column layout |
| `/stories` | Stories Feed | Blog-feed view of all stories |
| `/stories/:id` | Story Reader/Editor | Full-page reader with filmstrip; split-pane editor |
| `/map` | Map View | Interactive world map of geocoded event locations |
| `/assets` | Asset Gallery | Universal grid of all media; orphan detection |
| `/import` | GEDCOM Import | Upload form, hydration progress |
| `/settings` | Settings | System status, auth config, cache management, Git status |
| `/search?q=` | Search Results | Full-page search results (linked from CmdK "View all") |

### **6.3 Component System**

#### **6.3.1 Base Components (shadcn/ui)**

Import and customize these shadcn/ui primitives:

- `Button`, `Input`, `Label`, `Textarea` — form controls
- `Dialog`, `Sheet` — modals and slide-over panels
- `DropdownMenu`, `ContextMenu` — action menus
- `Command` (cmdk) — Command Palette foundation
- `Tabs` — panel switchers (Context Panel, Settings page)
- `Badge` — relationship type indicators, tags
- `Tooltip`, `HoverCard` — info on hover / person preview
- `Separator`, `ScrollArea` — layout utilities
- `Skeleton` — loading states
- `Sonner` (toast) — optimistic update confirmations and error notifications
- `Resizable` — panel resizing (Holy Grail columns)

#### **6.3.2 Custom Components**

| Component | Description |
|:----------|:------------|
| `Avatar` | Person photo (from first `assets` entry via `/assets/`) or generated initials. Circular, multiple sizes (sm/md/lg). Uses `object-cover` to fill the circle, cropping non-square images proportionally — never stretching or distorting. |
| `PersonChip` | Compact inline reference to a person: Avatar + Name + relationship type badge. Click → navigate to `/people/:id`. Hover → `HoverCard` with mini bio preview (name, dates, photo). |
| `EventCard` | Timeline item for a life event. Shows event type icon, date, location, description. Expand for details. Click to edit (inline or modal). |
| `StoryCard` | Timeline item for a story mention. Shows title, excerpt, mentioned persons. Click → expand/navigate. |
| `GapIndicator` | Visual break in timeline showing the year gap (e.g., "—— 15 years ——"). |
| `StatusDot` | Colored indicator: green (ready), amber (loading), red (error). Used in sidebar and top bar. |
| `HydrationProgress` | Full-screen overlay on boot. Connects to SSE stream, shows progress bar with phase/percent/node count. Fades out when `hydrationState === "ready"`. |

### **6.4 Command Palette (Cmd+K)**

The primary navigation and search tool. Built early — it drives all navigation and forces real search latency testing against the paginated `/api/search` endpoint.

- **Trigger**: Global hotkey `Cmd+K` / `Ctrl+K`, or click the search button in the Top Bar.
- **Foundation**: shadcn/ui `Command` component (wraps `cmdk` library).
- **Behavior**:
  1. On open: Focus input, show recent/suggested items and static Commands list.
  2. On keystroke: Debounced input (300ms) queries `GET /api/search?q=...&limit=20`.
  3. Results rendered in four categorized sections:
     - **People** (with Avatar thumbnail)
     - **Stories** (with title + excerpt)
     - **Places** (with location name)
     - **Commands** (static list, always visible — filtered by query string)
  4. Keyboard navigation: `↑`/`↓` arrows, `Enter` to select, `Escape` to close.
  5. On select: Navigate to `/people/:id` (person), `/stories/:id` (story), `/map?place=` (place), or execute command action.
  6. Footer action: "View all results →" links to `/search?q=...` full-page results.

**Commands List** (static, always present):

| Command | Action |
|:--------|:-------|
| Create Person | Navigate to `/people` with new-person dialog open |
| Import GEDCOM | Navigate to `/import` |
| Export GEDCOM | Trigger `GET /api/export/gedcom` download |
| Switch Theme | Toggle light/dark mode |
| Create Snapshot | Open snapshot dialog |
| Force Rebuild | Call `POST /system/rebuild` |
| View Map | Navigate to `/map` |
| View Assets | Navigate to `/assets` |

### **6.5 The "Holy Grail" Person Detail Page**

A dense, 3-column layout. The most critical view in the application.

```
┌──────────────┬──────────────────────┬──────────────┐
│   Identity   │      Timeline        │   Context    │
│   (Left)     │      (Center)        │   (Right)    │
│              │                      │              │
│  [Avatar]    │  ┌────────────────┐  │ [Tabs]       │
│  Name ✏️     │  │ Birth 1842     │  │ Assets|Notes │
│  Birth-Death │  │ Marriage 1867  │  │              │
│  ──────────  │  │ ── 12 years── │  │ [Asset Grid] │
│  Parents     │  │ Census 1880   │  │              │
│    [Chip]    │  │ Story: "The.."│  │ [Scrapbook]  │
│  Spouses     │  │ Death 1910    │  │              │
│    [Chip]    │  └────────────────┘  │ [Raw YAML]   │
│  Children    │                      │              │
│    [Chip]    │  [+ Add Event]       │              │
│  Siblings    │                      │              │
│    [Chip]    │                      │              │
│  ──────────  │                      │              │
│  Tags        │                      │              │
└──────────────┴──────────────────────┴──────────────┘
```

#### **6.5.1 Panel Behavior**

- **All three columns are collapsible and resizable** via drag handles (shadcn/ui `Resizable` / `react-resizable-panels`).
- Default proportions: ~20% / 50% / 30%.
- Collapsed state saved to Zustand store (persists across navigation within session).
- Responsive: On `<1024px`, right panel collapses to a bottom sheet. On `<768px`, single-column stacked layout with tab navigation between panels.

#### **6.5.2 Identity Panel (Left)**

- **Avatar**: Large circular photo (first `assets` entry) or generated initials.
- **Name**: Primary name displayed prominently. **Click-to-edit** — inline text field, saves via `PUT /people/:id` with optimistic update. Other names shown below in muted text.
- **Vital Dates**: Birth–Death date range. Click-to-edit.
- **Sex**: Badge indicator (M/F/I/U).
- **Private Toggle**: Small lock icon badge. When enabled, marks person as private (hidden in Guest Mode — see Section 6.14).
- **Relationship Sections** (from `_computed`): Collapsible groups for **Parents**, **Spouses**, **Children**, **Siblings**. Each person rendered as a `PersonChip`:
  - **Hover**: `HoverCard` shows mini bio preview — avatar, name, birth–death dates, relationship type.
  - **Click**: Navigate to `/people/:id` for that person.
  - Each group has **quick-action buttons**:
    - Parents: "Add Father" / "Add Mother" (separate buttons, sets relationship type hint)
    - Spouses: "Add Spouse/Partner" (opens Event Editor pre-set to `marriage` type)
    - Children: "Add Child" (creates new Person with current as parent)
    - Siblings: "Add Sibling" (creates new Person inheriting current person's parent IDs)
- **Tags**: Inline editable tag list with add/remove.
- **Stats Bar** (bottom of panel): Compact summary row — e.g., `Lived 42 years · 3 Children · 14 Stories`. Derived from `_computed` and story mention count. Clicking "14 Stories" scrolls Timeline Feed to StoryCards.

#### **6.5.3 Timeline Feed (Center)**

The integrated feed of life events, stories, and gaps. **Virtualized** — only visible items rendered via `@tanstack/react-virtual`.

- **Data Source**: `GET /people/:id?timeline_limit=50&timeline_offset=0`. Uses TanStack Query `useInfiniteQuery` for infinite-scroll pagination.
- **Virtualization reliability**: The virtualizer scroll container must have a deterministic, non-zero height on first render. The container must use explicit height (`h-full` on a flex-stretched panel, with the panel group having `h-full` from the route root) rather than relying on post-paint layout resolution. The virtualizer must observe the container for resize events so that if the initial height is 0, it recalculates automatically when the container reaches its final height. Timeline data must render correctly on both fresh in-app navigation and hard browser reloads.
- **Item Types**:
  - `UnknownDateHeader`: Section divider rendered at the very top of the feed when any undated items exist. Styled as "Undated Events" label. Only rendered once.
  - `EventCard`: Displays event type icon, date (fuzzy `date` + sort-date), location, description excerpt. Expandable for full detail. **If the event has a geocoded `location` (lat/lng populated)**, renders a small static **map snippet** below the location text — a thumbnail tile showing the pinned location. Clicking the map snippet opens the `/map` view filtered to that place.
  - `StoryCard`: Title, excerpt, mentioned persons as `PersonChip` links. **If the story has attached assets**, shows a **thumbnail of the first asset** as a leading image (aspect-ratio 16/9, `object-cover`). Clicking the card navigates to `/stories/:id`.
  - `GapIndicator`: Visual break showing year gap.
- **Add Event**: Floating action button or "+" button at bottom of timeline. Opens the Event Editor modal.
- **Edit Event**: Click an `EventCard` to open the Event Editor modal pre-filled with that event's data.

#### **6.5.4 Context Panel (Right)**

Tabbed panel with three tabs:

1. **Assets**: Grid of thumbnails (from `/assets/` static delivery). Click to expand/lightbox. Drag-and-drop upload via `PUT /people/:id/media`. Each thumbnail uses `object-cover` within a square aspect-ratio container (crops to square). Lightbox/full-size view uses `object-contain` to show the full image without cropping. Each thumbnail has a **delete button (×)** — clicking opens a confirmation dialog ("Delete this file permanently? This cannot be undone."). On confirm, calls `DELETE /api/people/:id/media/:filename`; asset removed from YAML and binary deleted from disk. **Optimistic update**: on confirm, immediately remove the asset from the local React Query cache before the API response (reverts on error). If the deleted asset was the primary photo, the avatar in the Identity Panel must immediately fall back to generated initials — no page reload required.
2. **Notebook**: Rendered Markdown view of `scrapbook_md` (lazy-loaded per spec 2.3B). In view mode, renders Markdown to HTML via `react-markdown` + `remark-gfm`, styled with Tailwind `prose` class. **Theme-aware prose**: use `prose-invert` only when dark mode is active. Click "Edit" button → plain `<textarea>` editor with Save/Cancel. Saves via `PUT /people/:id` with optimistic update.
3. **Raw YAML**: Read-only syntax-highlighted view of the source YAML file. Useful for power users and debugging.

#### **6.5.5 Event Editor**

Full modal-based event editor for creating and editing all 16 event types. This is the primary data entry surface.

- **Trigger**: "Add Event" button or clicking an existing event card.
- **Layout**: Modal (`Dialog`) with:
  - **Event Type Selector**: Dropdown with all 16 types. Selecting a type dynamically shows/hides type-specific fields (e.g., `partner_id` for marriage, `cause` for death, `institution`/`degree` for education, `branch`/`rank` for military_service).
  - **Common Fields**: `date` (free text, fuzzy — validated in real-time by the frontend `parseToISO()` function; parsed ISO preview shown below field; **Save disabled** if non-empty and unparseable; **strict token matching** — unrecognized word tokens cause validation failure even if a 4-digit year is present in the string, e.g., "15 Jeune 1776" must fail validation because "Jeune" is not a recognized month abbreviation and must not silently fall back to "1776-01-01"), `sort_date` (ISO `YYYY-MM-DD` — **Save disabled** if non-empty and invalid), `location` (type-ahead input querying `GET /api/places/search`, shows resolved coordinates when a candidate is selected), `description` (Markdown textarea), `assets` (file selector).
  - **Type-Specific Fields**: Rendered conditionally based on selected event type (see spec Section 3.2).
  - **Partner Selection** (marriage/divorce): Searchable person selector that queries the graph — type-ahead with `PersonChip` results.
- **Validation**: Client-side Zod validation mirroring the backend `EventSchema`. Show field-level errors immediately.
- **Save**: `PUT /people/:id` with the updated events array. Optimistic update via TanStack Query mutation.

#### **6.5.6 Relationship Editor**

For editing parent relationships (the only stored relationships per spec Section 3.1).

- **Location**: Section within the Identity Panel, or accessible via "Edit Relationships" button.
- **Tabs**: Parents | Children | Spouses | **Siblings**.
- **Add Parent**: Searchable person selector (same component as partner selection). Select relationship type (biological/adopted/step/foster).
- **Remove Parent**: Confirm dialog before removing.
- **Siblings tab**: Siblings are derived from shared parents (`_computed.siblings`) — they cannot be stored directly. The Siblings tab displays current siblings as read-only `PersonChip` links. To link a new sibling, the user picks a person via search, then selects **one or more** of the current person's parents to assign to that sibling (each shown as a `PersonChip` with a checkbox; all checked parents are added simultaneously). Calls `PUT /people/[siblingId]` once with the full updated parents array. If the current person has no parents, the tab shows a hint to add parents first before linking siblings. A tooltip explains that sibling removal is done by managing the shared parent relationship.
- **Save**: `PUT /people/:id` with updated `relationships.parents` array. Backend handles edge reconciliation and `_computed` invalidation.

### **6.6 People Browse Page**

Searchable, sortable table/list of all people in the graph. Entry point from the sidebar.

- **Data Source**: Requires a new `GET /api/people` list endpoint (see Section 6.10 below). Returns paginated slim person summaries.
- **Layout**: Dense table with columns: Avatar, Name, Birth Date, Death Date, Tags, # Events. Sortable by any column.
- **Avatar column**: Displays the person's primary photo (first `assets` entry, provided as `primaryAsset` in `SlimPersonSummary`) if available, otherwise generated initials. Requires `primaryAsset?: string` field added to `SlimPersonSummary` by the `GET /api/people` endpoint.
- **Search**: Server-side search using `GET /api/search?q=...` — not client-side filtering. The inline filter queries the full dataset, not just the current page. Typing resets pagination to offset 0.
- **Click Row**: Navigate to `/people/:id`.
- **Bulk Actions** (Phase 5+): Multi-select for tagging, exporting.
- **Virtualization**: Table body uses `@tanstack/react-virtual` for large datasets.

### **6.7 Dashboard**

The landing page. Overview of the family graph.

- **Stats Panel**: Cards showing Total People, Total Families (derived from marriage events), Last Edited File (from git log or `last_modified`), System Status.

- **Visualization Mode Toggle**: Three switchable views, toggled by a segmented control (icons + labels):

  #### Mode 1: Force Graph
  - **Library**: `react-force-graph-2d`.
  - Nodes = people, edges = parent-child + spouse relationships.
  - **Interaction**: Click node → navigate to `/people/:id`. Drag to rearrange (springs back on release).
  - Spouse bonds visually distinguished: **solid edge** (active marriage) vs **dashed edge** (divorced/widowed).
  
  #### Mode 2: Fan Chart
  - **Full 360° ancestor circle** centered in viewport, radiating from a selected root person.
  - Each generation occupies a ring; root person circle at the center of the viewport.
  - **Color-coded by lineage**: hue-interpolated paternal (blue 220°) → maternal (rose 340°) branches.
  - **Generation depth selector**: buttons to show 3–6 generations.
  - **Pan/zoom**: pointer drag to pan, scroll-wheel to zoom (cursor-relative), reset button.
  - **Click arc to re-root**: clicking a filled ancestor arc re-roots the chart to that person (stays on dashboard).
  - Root person selector: shared focal picker in dashboard header.
  - Arc labels shown when angular width ≥ 0.22 rad; truncated to fit.

  #### Mode 3: Pedigree Chart
  - **Bidirectional adaptive tree**: shows both ancestors (negative generations) and descendants (positive generations) from the focal person.
  - **Adaptive layout**: simplified Reingold-Tilford algorithm — spacing adapts to actual subtree sizes instead of fixed 2^n slots.
  - Users can toggle between **horizontal** (ancestors left, descendants right) and **vertical** (ancestors above, descendants below) layouts with `aria-pressed` toggle buttons.
  - **Progressive disclosure**: default 3 generations up + 3 down (2+2 on mobile). Expand chevrons on boundary cards reveal additional ancestors, descendants, or siblings per-node.
  - **Person preview**: click a card to show a popover (desktop ≥ 640px) or bottom sheet (mobile < 640px) with name, birth year, sex badge, primary asset thumbnail, and action buttons.
  - **Re-root from tree**: "Make focal person" button in preview re-roots the entire tree to the clicked person.
  - **"View profile"** button navigates to `/people/:id`.
  - **Pan/zoom**: pointer drag to pan (5px threshold to distinguish from clicks), scroll-wheel to zoom (cursor-relative), +/−/reset buttons.
  - **Responsive**: cards scale down on narrow viewports; mobile uses bottom sheet for preview; reduced default depth on mobile.

### **6.8 Import & Settings Pages**

#### **6.8.1 Import Page**

- **GEDCOM Upload**: Drag-and-drop file zone. Accepts `.ged` files.
- **Warning**: Clear destructive action warning ("This will replace all existing data. Git history is preserved.").
- **Progress**: After upload, connect to `GET /system/hydration/stream` SSE and show real-time progress bar (phase, percent, node count).
- **Completion**: On `complete` event, redirect to Dashboard with success toast showing node count.

#### **6.8.2 Settings Page**

- **System Status**: Live display of `GET /system/status` data — node count, edge count, hydration state, cache age.
- **Cache Management**: "Force Rebuild" button → `POST /system/rebuild`. Shows progress via SSE.
- **Snapshot**: "Create Snapshot" → `POST /system/snapshot`. Input for snapshot name.
- **Authentication** (when active): Current user display, logout button.

### **6.9 Stories Pages** *(implemented — Phase 5.1)*

#### **6.9.1 Stories Feed (`/stories`)**

Blog-feed view of all story Markdown files. Entry point from sidebar.

- **Layout**: Single-column feed, newest-first by default. Each entry is a `StoryFeedCard`:
  - Hero image (first story asset, if any) — 16:9, `object-cover`
  - Title (links to `/stories/:id`)
  - Date range (e.g., "1939–1945")
  - Excerpt (first 200 chars of body text)
  - Tagged people as `PersonChip` links (up to 5, then "+N more")
  - Tagged place (if present)
- **Sorting**: newest / oldest / alphabetical — segmented control.
- **Search**: Inline filter queries `GET /api/search?q=...` Stories category.
- **Create Story**: "New Story" button → opens `/stories/new` (editor in create mode).
- **Virtualization**: `@tanstack/react-virtual` for large story collections.

#### **6.9.2 Story Reader (`/stories/:id` — view mode)**

Clean reading experience for a single story.

- **Layout**: Centered column (max 720px), wide margins. Typography: `Merriweather` serif.
- **Header**: Title, date range, tagged places, tagged people as `PersonChip` row (from `people` frontmatter, auto-populated from @mentions on save).
- **Body**: Rendered by `MilkdownEditor` in `readOnly` mode (same component used for edit mode — keeps view/edit parity). `@N_xxx` mentions are decorated as inline chips with person's display name and HoverCard preview, via ProseMirror `Decoration.inline` + CSS `::before`.
- **Filmstrip**: Horizontal scrollable strip of all story assets at the bottom. Each image: square thumbnail, `object-cover`. Click → lightbox (full `object-contain`).
- **Edit Button**: "Edit Story" in top-right → switches to editor mode (same URL, `?mode=edit`).
- **Breadcrumb**: `← Stories / [Title]` — "Stories" link navigates back to feed (restoring persisted filter/sort). The top-bar static "Home > Current Page" breadcrumb has been removed from `TopBar.tsx`.

#### **6.9.3 Story Editor (`/stories/:id?mode=edit` or `/stories/new`)**

Rich WYSIWYG editing experience powered by **Milkdown Crepe**.

- **Unified layout**: Both view and edit modes use the same `max-w-[720px]` centered column width.
- **Editor**: Milkdown Crepe (`@milkdown/crepe`) with full feature set: ListItem (todo lists, bullets, ordered), LinkTooltip, ImageBlock, BlockEdit (slash commands + drag handles), Table, Toolbar (formatting bar), Cursor, Placeholder.
- **Frontmatter fields** (above editor in edit mode): Title (large serif input), Date (SmartDateInput), Place (PlaceSearchCombobox), Private toggle.
- **@Mentions**: Type `@` to open suggestion dropdown (queries `GET /api/search?q=`). Shows person name + birth year. Arrow-key + Enter selection. Inserted as `@N_xxx` in Markdown. While typing `@` a query using name fragments works (space-separated).
  - In editor: `@N_xxx` text decorated as styled chips with person's name (via ProseMirror `Decoration.inline` + CSS `::before`). Names pre-fetched from `GET /api/people/:id` on load.
  - On mention click (readonly or editor): navigates to person's detail page.
  - On save: auto-extracted into `people` frontmatter array.
- **Asset Attachment**: Drag-and-drop onto editor — uploads via `PUT /stories/:id/media`, inserts `![name](/assets/filename)`.
- **Save**: `PUT /stories/:id` (or `POST /stories` for new). Auto-extracts @mentions → `people` array.
- **Auto-save**: Debounced 3-second auto-save while editing.
- **Navigation**: Breadcrumb `Stories / [Title]` in story header — "Stories" is a clickable link back to the feed.

#### **6.9.4 Stories Feed behavior**

- **Whole-card click**: Entire `StoryFeedCard` container navigates to the story (not just title).
- **Sort/filter persistence**: Filter text and sort order persisted in Zustand (`storiesFeedFilter`, `storiesFeedSort`) — restored when user navigates back from a story.
- **Excerpts**: Plain text only — markdown formatting stripped server-side before truncation.

#### **6.9.5 Notebook Tab (Person Detail)**

- Milkdown Crepe editor (readonly until "Edit" is clicked). Renders via Crepe in readonly mode when not editing.

---

### **6.10 Asset Gallery Page (`/assets`)** *(implemented — Phase 5.4/5.4b/5.4c)*

Universal gallery of all files in the `/assets` directory.

- **Layout**: Fixed 3-column grid of 4:3 aspect ratio cards (`object-contain`). Virtualized via `@tanstack/react-virtual`.
- **Each asset card**: Thumbnail, filename overlay.
- **AssetDetailModal**: Click card to open left image + right metadata panel. Keyboard navigation (←/→). Description edit, date_taken edit, person tag/untag via `PersonSearchCombobox`, orphan delete.
- **Toolbar**: Type filter (`all`/`image`/`document`), sort (name/size/date) with asc/desc toggle, backend-driven search (`?q=` searches filename, description, person names, story titles).
- **Orphan Detection**: Assets not in any `person.assets[]` or story Markdown flagged as orphaned. `DELETE /api/assets/:filename` only allowed for orphans (guard).
- **Bulk Upload** (`BulkUploadDialog`): Drag-drop zone, image previews, shared metadata form (description, date, location via PlaceCombobox, people tagging). `POST /api/assets/upload` (multipart, multi-file, EXIF seed, dedup).
- **API**:
  - `GET /api/assets` — `?q=`, `?type=image|document|all`, `?sort=name|size|date`, `?order=asc|desc`
  - `PUT /api/assets/:fn/meta` — `description` + `date_taken` (`caption` accepted as legacy alias)
  - `DELETE /api/assets/:fn` — file deletion (orphan guard)
  - `POST /api/people/:id/assets/link` — link existing asset to person
  - `DELETE /api/people/:id/assets/link/:filename` — unlink asset from person (removes from `person.assets[]` and `event.assets[]`)
  - `POST /api/assets/upload` — bulk upload with EXIF metadata extraction

---

### **6.11 Map View (`/map`)**

A global-overview map that treats the world as a stage for your family's events. Country and state/province polygons anchor the eye; major cities label the major orienting landmarks; events appear as a warm-amber heatmap glow when zoomed out and as type-colored pins when zoomed in. A bottom-docked time window lets the user "fly through history" — step-wise playback across the extent of the data.

#### Design intent

- **Self-hosted and offline-first by default.** The Map View must work on a laptop with no network connection. The basemap, fonts, and event data all live inside the LegacyGraph install. There are **no third-party CDN dependencies at runtime** — no Carto, MapTiler, Stadia, Protomaps API, or `demotiles.maplibre.org`.
- **Global overview, not street atlas.** The map answers "where has my family been across time?" not "which street did they live on?". Country, admin-1 (state/province), and major-city granularity is the goal; streets, POIs, and buildings are explicitly out of scope.
- **One-time bundle, no build step for the user.** Basemap data ships with the SPA build. There must be no `npm run basemap:build` requirement for end users.

#### Basemap

- **Source**: Natural Earth — public-domain, redistributable. Mixed 1:10m and 1:50m scales chosen per layer to balance fidelity against bundle size. Seven GeoJSON files shipped under `client/public/basemap/`:
  - `countries.json` — NE **1:10m** `ne_10m_admin_0_countries`, simplified to 30% retention. Kept properties: `NAME`, `ISO_A2`. *1:10m is required so fjord coastlines (Vancouver Island, Norway) and small island archipelagos (Hawaii, Canadian Arctic) read as their actual shapes; 1:50m collapses these to 5-vertex polygons.*
  - `country-labels.json` — derived from the same 1:10m admin_0 source via mapshaper's `-points inner` (pole-of-inaccessibility — guaranteed inside polygon, visually centered). Kept properties: `NAME`, `MIN_LABEL`. *Separate point source because rendering one symbol per polygon produces ~20 "Canada" labels for the Arctic Archipelago.*
  - `states.json` — NE **1:50m** `ne_50m_admin_1_states_provinces_lines` (interior boundaries only — no coastlines), simplified to 15% retention. No kept properties (the layer paints uniformly). *Lines variant is critical to avoid the "double-trace ghost" effect where state-polygon perimeters retrace the same coast as `countries` at a different scale, producing two visibly offset coastlines.*
  - `state-labels.json` — derived from NE **1:10m** `ne_10m_admin_1_states_provinces` polygons via `-points inner`. Kept properties: `name`, `min_zoom`. *Polygon source is the 10m variant so label points align with country geometry.*
  - `lakes.json` — NE 1:50m `ne_50m_lakes`, simplified to 50% retention. Kept properties: `name`. Rendered with the basemap `background` color so lakes appear as cutouts in the country fill — Great Lakes, Lake Victoria, Caspian, etc.
  - `places.json` — NE **1:10m** `ne_10m_populated_places_simple`, pruned at build time to `rank_max >= 4` (~6,800 of ~7,300 cities kept). *1:10m is required so major U.S. metros (San Francisco, Phoenix, Las Vegas, Reno) appear at all — the 1:50m `_simple` variant ships only ~243 places worldwide and excludes most state capitals. The prune is lossless at runtime: the city-label filter's rank threshold bottoms out at 4 at the zoom-8 basemap cap, so lower-ranked features could never render and would be pure payload + symbol-collision cost.* Kept properties: `name`, `pop_max`, `rank_max` (guarded by `basemapData.test.ts`).
  - `graticules.json` — NE 1:50m `ne_50m_graticules_15` (15° lines).
- **Pipeline**: a build-time script (`scripts/buildBasemap.ts`) downloads the Natural Earth shapefiles into `.tmp/basemap/`, then drives mapshaper via `npx --yes mapshaper@<pinned>` to produce each output (`-simplify <pct>% keep-shapes`, optionally `-points inner` for label sources, then `-filter-fields` and `-o format=geojson`). The script emits **plain GeoJSON only** — gzip happens at HTTP transport time via `@fastify/compress`, no pre-compressed `.json.gz` siblings. Output files are committed to git (~6 MB raw / ~1.5 MB gz total — well under the 30 MB raw / 6 MB gz budget) so end users do not need to run the script. mapshaper and shapefile are invoked via `npx --yes` and **not added to `package.json`** — keeps the dev install lean. The script runs only for upgrades to a newer Natural Earth release.
- **HTTP transport**: `@fastify/compress` is registered globally (`{ encodings: ['br', 'gzip'] }`) and gzips JSON responses on the fly. Vite dev gzips automatically.
- **Glyph stack**: Open Sans Regular is shipped at `client/public/fonts/Open Sans Regular/{range}.pbf` (256 PBF ranges, ~1.4 MB on disk; ~75 KB fetched per Latin-locale session). MapLibre lazy-loads only ranges that contain rendered glyphs. Source: a one-shot script (`scripts/buildBasemapFonts.ts`) shallow-clones the upstream `openmaptiles/fonts` repo's `gh-pages` branch (which carries pre-built PBFs) and copies the `Open Sans Regular/` directory. **No npm dependency** — the upstream `@openmaptiles/fonts` npm package ships TTF source + a fontnik build pipeline (heavy native deps), not the rendered PBFs. MapLibre's `style.glyphs` is the relative URL `/fonts/{fontstack}/{range}.pbf`.
- **Rendering**: MapLibre v5 reads the seven GeoJSON files via separate `geojson` sources (no tile server required). Day and night styles share identical layer structure (id + type + order) and differ only in paint colors — required for `setStyle({ diff: true })` patching. Layer order (drawn back-to-front):
  1. `background` — flat fill (palette: light `#e6eef5` / dark `#05090f`).
  2. `country-fill` — light `#f8f7f2` / dark `#0f1626`.
  3. `lake-fill` — same color as `background`, so lakes appear as water cutouts in the land.
  4. `country-boundary` — line, always visible.
  5. `state-boundary` — line, `minzoom: 3`.
  6. `graticules` — dashed line.
  7. `country-label` — `maxzoom: 5`. Per-feature filter `MIN_LABEL <= zoom + 2` so major countries clear at zoom 0 (USA `MIN_LABEL ≈ 1.7`) while tiny territories (Clipperton, San Marino, Andorra at `MIN_LABEL ≈ 7-8`) never clear inside the `maxzoom: 5` cap.
  8. `state-label` — `minzoom: 4`. Per-feature filter `min_zoom <= zoom` so large admin_1s (California, Quebec, NSW) appear early and tiny ones (Samoan villages, Caribbean parishes) only appear at higher zooms. Styled as atlas-watermark: `text-transform: uppercase`, `text-letter-spacing: 0.18`, muted color (`#9b937f` light / `#6b7891` dark), `text-opacity: 0.7`, plus `text-allow-overlap: true` + `text-ignore-placement: true` so state names always render and never push city labels aside.
  9. `city-label` — `minzoom: 4`. Per-zoom filter `rank_max >= interpolate(zoom, 4→11, 6→8, 8→4)` (NE's `rank_max` is *higher = more important*: NYC=14, SF=12, Elko=5). Collision priority: `symbol-sort-key: ['-', 0, ['to-number', ['get', 'pop_max'], 0]]` — MapLibre draws lowest sort-key first, so subtracting `pop_max` from 0 makes the most populous city render first and win automatic collision dedup over smaller neighbours (SF beats Oakland, etc.).
- **Style application**: theme toggling uses `map.setStyle(style, { diff: true })`. Because day/night styles share layer structure exactly (one `themedStyle(theme)` factory, no hand-maintained pair), MapLibre patches paint without re-fetching the GeoJSON sources or re-tessellating geometry — instantaneous re-style with no relayout flash.
- **Zoom range**: `minZoom: 0`, `maxZoom: 8` (hoisted as `BASEMAP_MAX_ZOOM` so the ctor cap and `fitBounds` cap can never drift). Beyond zoom 8 the Natural Earth geometry is unhelpful; the basemap explicitly stops there. The deck.gl event overlay still renders at any zoom.
- **No raster tiles, no PMTiles, no MBTiles**. The previous PMTiles direction was prototyped and rejected (135 GB planet build is wildly out of scale for our zoom range, and a self-hosted runtime tile reader is more moving parts than the dataset warrants).

#### Event overlay (deck.gl)

- **Libraries**: `@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/aggregation-layers`, `@deck.gl/mapbox`. Mounted via `MapboxOverlay` so deck.gl layers composite with the MapLibre basemap.
- **Rendering modes (zoom-driven crossfade)**:
  - `zoom < 3`: `HeatmapLayer` glow over an **ember under-layer** (`events-embers` — a 1.5 px warm dot per event). The heatmap normalizes its color scale to the densest cluster in view, so isolated events land below its threshold; the embers are the visibility floor that keeps the sparse end of the dynamic range on the map.
  - `3 ≤ zoom < 5`: heatmap + embers fade out, individual pins fade in (`opacity` is a uniform — no GPU re-tessellation per fade frame).
  - `zoom ≥ 5`: `ScatterplotLayer` pins only — type-colored. Click → side drawer (bottom sheet on mobile) with event card, person chip, "Set as focal", "Open on Graph". *(A previous design jittered pin positions by ~25 m per hashed event id to make city-centroid stacks clickable; that was removed — at the zoom-8 basemap cap, 25 m is ~1/20 px, so the jitter was invisible and stacks remained un-clickable. Co-located events are instead disambiguated at pick time — see "Stacked events" below.)*
- **Stacked events**: events geocoded to the same place share one exact point, and the zoom-8 cap (~600 m/px) means stacks never spread apart visually — so a naive click can only ever reach the topmost pin. A pin click therefore runs `pickMultipleObjects` (4 px radius, depth 24, pins layer only) via the `MapboxOverlay`. One unique hit opens the event card directly; multiple hits open a **co-located event list** in the drawer (`"24 events at California"` — one row per event with its type color dot, type, person name, and year). Selecting a row shows that event's card with a back affordance to the list. `?event=` deep-links only a selected card; the list itself has no URL representation.
- **Heatmap weighting**: event type drives intensity. Birth/death/marriage = 1.0, engagement/occupation/residence/military_service/immigration/emigration/adoption ≈ 0.6–0.7, education/baptism/burial ≈ 0.5, census = 0.3, generic = 0.4. Keeps decadal census spikes from dominating real life events.
- **Dynamic range**: the heatmap auto-normalizes to the densest cluster in view, which used to erase everything sparse (a 20-event town next to a 500-event city fell below the render threshold; single events vanished entirely). Three coordinated measures fix this: the **ember under-layer** guarantees every event a visible dot at low zoom; the heatmap `threshold` is **0.01** (was 0.03) so faint areas aren't culled; and the warm-amber `colorRange` is **gamma-compressed** — most of the luminance ramp is spent on the low end so minor clusters read clearly while hotspots still saturate at the top stops. Change these only while comparing a sparse and a dense window side by side.
- **Heatmap radius**: `radiusPixels` is a **constant 40 px by design**. Zoom-interpolating it (an earlier `30 → 60 px` idea) was prototyped and rejected: changing `radiusPixels` forces `HeatmapLayer` to regenerate its weight texture on every zoom frame, producing visible choppiness in exactly the range users notice. A fixed radius keeps the glow stable across the zoom crossfade; the marginal anemia at very low zoom on 4K displays is an accepted trade-off for smooth interaction. `radiusPixels` must **not** be placed in `updateTriggers`.
- **Connected path**: when scope is `Focal person`, draws two stacked `PathLayer`s — a 5 px halo (background-toned, contrast-flipped per theme) and a 3 px stroke on top — through the focal's events in chronological order (birth → residences → death) above the pins. The focal's events are pre-computed once per `(events, focalPersonId)` change and reused across window/zoom updates.
- **Stable accessors**: `getFillColor`, `getRadius`, `getPosition`, `getWeight` are module-scope constants. The deck.gl `data` array uses prepared event objects (`prepareEvents` — `startYear`/`endYear` parsed once per data load) so window/zoom/theme changes do not force GPU vertex re-uploads. The prepared array is memoized on `events.data` (not `dataUpdatedAt`) so React Query's structural sharing keeps every downstream memo, GPU buffer, and heatmap texture identity-stable across refetches that return identical data. `updateTriggers` is set only on layers whose accessors genuinely close over reactive state (e.g. nothing in v1 — all reactive concerns are encoded into the `data` reference or `opacity` uniform).
- **Window-visibility filter runs on the GPU** (`DataFilterExtension`, `filterSize: 2`). Each event carries a static 2-component filter value `[endYear, startYear]` (pre-parsed in `prepareEvents`); the window becomes the per-component `filterRange` `[[windowStart, +B], [-B, windowEnd]]`, so an event passes iff its year interval overlaps the window. Undated events get `±B` sentinels (`B = 1,000,000`) so they pass every window; their visibility — like the event-type filter — is decided by a CPU filter over the prepared array, but both of those change only on explicit checkbox clicks. The payoff: **scrubbing and playback change only a uniform** — no CPU filter pass, no array allocation, no GPU attribute re-upload. The pins layer just re-draws; the heatmap re-runs its weight-aggregation pass (one GPU point-draw over unchanged buffers).
- **`FilteredHeatmapLayer`** (`layers/FilteredHeatmapLayer.ts`): deck.gl 9.3's stock `HeatmapLayer` is broken under `DataFilterExtension` in three ways, all because its aggregation runs in an internal `TextureTransform` rather than a layer draw: the dataFilter uniform block is never populated for the weights transform (aggregation silently unfiltered); a `filterRange` change never marks the weight texture dirty (glow frozen while pins filter); and the extension's `filterValues` attribute resolves `stepMode: 'dynamic'` → `'instance'` on the non-instanced weights draw (every vertex reads event[0]'s filter value — all-or-nothing rendering). The subclass patches all three; see its header comment before touching. Additionally `_subLayerProps: { 'triangle-layer': { extensions: [] } }` strips the extension from the heatmap's internal screen-space triangle pass, which has no per-event attributes and would otherwise discard every fragment.
- **Heatmap aggregation must not re-run per zoom step** — two invariants in `buildMapLayers`, both diagnosed from measured 200–250 ms frame stalls (M2, DPR 2) that made zooming choppy below zoom 5 while zoom ≥ 5 stayed at a flat 16.7 ms:
  - **`_subLayerProps` is a module-scope constant** (`HEATMAP_SUBLAYER_PROPS`), never an inline literal. It is not in `HeatmapLayer`'s `ignoreProps` set, so a new object identity per build makes `isAggregationDirty({ compareAll: true })` report `"props._subLayerProps changed shallowly"` → `dataChanged` → the 500 ms debounce is cleared and the weight aggregation re-runs *immediately*. Layers rebuild on every 0.5-zoom-step quantization below zoom 5 (`layerZoom = Math.min(zoom, 5)`), so this cost 6 stalls per 2.5-zoom-level sweep; a stable reference reduces that to the single debounced aggregation after the zoom settles.
  - **`weightsTextureSize` is 1024**, not the 2048 default (`HEATMAP_WEIGHTS_TEXTURE_SIZE`). `HeatmapLayer` reduces the weights texture to a 1×1 max by drawing `weightsTextureSize²` point vertices that all blend-max into a single texel, so the raster ops fully serialize: 2048 → 4,194,304 vertices ≈ 200 ms of pure GPU time per aggregation (no JS long task — the main thread is idle while ~13 frames drop). 1024 measured ~50 ms. Do not raise it; lowering further buys nothing (512 and 256 also measured ~50 ms) and shrinks the cached world-bounds margin (`textureSize * 2 / viewport.scale`), which makes zoom-out escape its bounds and re-aggregate more often.
  - Why zoom ≥ 5 was always smooth, for contrast: `layerZoom` is clamped at 5, so the `layers` array stays referentially stable → no `setProps`, no heatmap update, zero aggregations (measured), and the layer is `visible: false` so it is not drawn either.

#### Time window + playback

Bottom-docked, mobile-expandable.

- **Dual-handle range slider** over `[extentStart, extentEnd]` (auto-fit from the loaded events). Implemented with `@radix-ui/react-slider` in range mode (Radix is already a dep). The user moves either handle to widen, narrow, or shift the window. Thumbs snap to **1-year** increments regardless of granularity (`minStepsBetweenThumbs: 1` → minimum window width 1 year).
- **Step ≠ width.** Two distinct per-granularity constants live in `timeStore.ts` and must not be conflated (a historical bug did): `STEP_YEARS` (**1 / 10 / 100** — how far one playback tick or arrow key moves the window; exactly what the "1 yr / 10 yr / 100 yr" step labels say) and `GRANULARITY_WIDTH` (**5 / 20 / 100** — the *default window width* used only when seeding).
- **Step playback advances both handles by one `STEP_YEARS` unit per tick, preserving the *current* width** (i.e. whatever the user has just dragged the handles to). The advance is computed by the pure `advanceWindow()` (unit-tested), which also **clamps the step to the window width** — a 100-yr step with a 5-yr window advances 5 years per tick, so playback never jumps past years the window has not shown. The width is read fresh from `useTimeStore.getState()` inside the interval, so a user dragging a handle mid-playback immediately changes step behavior on the next tick.
- **Default window seeding**: when `initWindowForExtent(min, max)` runs (gated by `extentSeeded`, see below), the initial window is `[min, min + GRANULARITY_WIDTH[granularity]]`, **not** the full extent. This guarantees there is something to "fly through" — a 200-year-wide window over a 200-year extent would render a static heatmap and defeat the time-travel UX. A window deep-linked via `?t=&t_end=` is seeded with `seedWindowFromUrl()`, which sets `extentSeeded` so the extent init after the first data load cannot clobber it.
- **Event-count context strip**: an 80-bin histogram of event counts across the extent renders directly above the slider track (`computeYearHistogram`, unit-tested), so the user can see where in time the data lives before scrubbing or playing. Range events count in every bin their interval overlaps (the same overlap semantics as the window filter); undated events are excluded. Bars are muted (`bg-muted-foreground/25`), sqrt-scaled with a minimum bar height so sparse bins stay visible next to dense ones, and purely decorative (`aria-hidden`, no hover — the slider is the interaction). It reflects the event-type/undated filter, not the time window.
- **Readouts**: the extent min/max render as small muted labels at the track ends; the current window renders as a centered readout under the slider (`1880 – 1910 · 30 yrs`). (A previous layout put the *window* bounds where axis extent labels normally sit, which read as the timeline's range.)
- **Speed**: `0.5×` / `1×` / `2×` / `4×`. Step and Speed selects carry visible labels and real tooltips (shared Tooltip component, not `title` attributes).
- **Loop toggle**: when on, playback wraps to `extentStart` after passing `extentEnd`; when off, playback stops at the end.
- **Step-wise playback** (not continuous): `setInterval` advances the window by one step per tick (year ≈ 2 s/tick at 1×, decade ≈ 1 s, century ≈ 0.8 s). Each tick is a GPU filter-uniform update (see event overlay), so tick cost is independent of event count.
- **Scrub** pauses playback; no auto-resume. **The map updates live during the drag**: `TimeSlider` keeps the thumbs glued to the pointer via local React state and pushes the pending `[start, end]` into `useTimeStore` at most once per animation frame (rAF-throttled). Live updates are affordable because a window change is a GPU filter-uniform swap (see above), not a data rebuild. `onValueCommit` (Radix's pointer-release event) cancels any pending rAF and commits the final value.
- **Keyboard**: `Space` toggles play, `←` / `→` step the window by one `STEP_YEARS` unit, `Shift+←/→` jumps 10 units. The window-level handler ignores key events when focus is on a form control, button, or slider thumb — buttons/selects own Space/arrows natively, and Radix handles arrow keys on its thumbs (per-thumb, 1-yr steps).
- **"Show undated" toggle**: events with `sort_date == null` become visible and the window is ignored for them.
- **Range events** (residence, occupation, military_service, …) are visible whenever `[sort_date, sort_end_date]` overlaps the window.

#### Filters and scope

- **Scope control**: `Everyone` / `Focal person` / `Focal lineage`. Shares `useFocalStore` with the Graph page so focal state round-trips bidirectionally. `Focal lineage` = direct ancestors + direct descendants + spouses of every lineage member (siblings/cousins excluded). Lineage walks the `child_of` edge regardless of the relationship's `type` — so adopted-in / adopted-out chains and step-relations *are* included if the underlying `child_of` edge exists. (Granular filtering by relationship subtype is out of scope for v1.)
- **Scope persists across focal changes.** Switching the focal person on the Graph page does not wrench the user's selected scope on the Map page out from under them — `useMapPrefsStore.scope` is independent of `useFocalStore.focalPersonId`.
- **Event-type filter**: lives in `MapToolbar` as a collapsible **"Event types" popover in the global TopBar** (the map's action cluster is portaled into the TopBar via `TopBarActions`; there is no separate `MapLegend` overlay). This popover doubles as the map's legend: one row per `EVENT_TYPES` member with a color swatch (from `TYPE_COLORS`) and a checkbox, plus `All` / `None` quick buttons at the top. The trigger button shows a `<count>/<total>` badge when a filter is active. Backed by `useMapPrefsStore.eventTypes` (`null` = all types visible, an array = explicit filter set; empty array = nothing visible). Toggle semantics:
  - Clicking a type when `eventTypes === null` switches to "all types except clicked".
  - Clicking otherwise toggles set membership.
  - When toggling produces a set equal to all event types, `eventTypes` collapses back to `null` (keeps the URL/store shorter and means the heatmap is unfiltered).
  - `All` resets to `null`; `None` sets to `[]`.
- The filter is applied alongside the time-window filter inside `MapView`'s `visible` `useMemo` against a `Set<EventType>` for O(1) per-event cost. The focal `PathLayer` is intentionally unfiltered — the focal path is a structural feature, not a per-event view.
- **Fly-to**: `map.fitBounds` on every scope or focal change, using the bounding box of the filtered data. Does **not** re-fire on React Query refetches; gated by a ref keyed on `${scope}:${focalPersonId}:${eventCount}`. `maxZoom` for fitBounds is 8 to match the basemap cap.

#### Day/night themes

Map style follows `useUIStore.theme`. Both styles live in `client/src/features/map/styles/` and differ only in paint colors; layer structure is identical so `setStyle({ diff: true })` patches paint properties without re-fetching sources.

#### State stores

Map state is split across three Zustand stores by lifetime, with the URL as a fourth weaker persistence surface. Each store has a single, well-bounded responsibility:

- **`useFocalStore`** (`client/src/shared/store/focalStore.ts`, persisted to `legacy-graph-focal-v1`) — the shared focal person, read and written by both the Graph and the Map. Cross-feature state, not map-specific.
- **`useMapPrefsStore`** (persisted to `legacy-graph-map-prefs-v1`) — `scope`, `granularity`, `speed`, `loop`, `eventTypes`. User preferences that should survive reloads and follow the user across sessions.
- **`useTimeStore`** (in-memory only, seeded from the API extent on first data load) — `windowStart`, `windowEnd`, `extentStart`, `extentEnd`, `extentSeeded` (boolean — `false` until the first successful seed, `true` thereafter; replaces the brittle "is extent still at defaults?" heuristic), `showUndated`, `isPlaying`. Per-session view state; deliberately not persisted so reloading does not strand the user mid-playback at a stale window.
- **URL search params** (fourth, weakest layer) — On mount, `MapView` boots store values from `?scope=&person=&t=&t_end=&g=&speed=&play=&loop=&event=` (read imperatively off router state, not via a reactive subscription). After boot, `MapView` subscribes only to `?event=` (`useSearch` with a `select`) — subscribing to the whole search object would re-render the component on every debounced URL write-back, i.e. every playback tick. A debounced effect (200 ms) writes store changes back via `navigate({ replace: true })`. **`?event=` is written and cleared synchronously** (not via the debounced effect) on drawer open/close to avoid a race where the URL still says `?event=X` after the user has just closed the drawer. **`t` and `t_end` are omitted from the URL when the window equals the extent**, keeping a clean URL for users who haven't scrubbed. The URL is the share/restore surface; the stores are the runtime source of truth.

#### Backend

- **Endpoint**: `GET /api/map/events` returns `{ events: MapEvent[], extent: { minDate, maxDate, bbox } }`.
  `MapEvent` = `{ id, person_id, person_name, type, lat, lng, sort_date, sort_end_date, has_assets, place_name }`.
- **Query params**: `?person=N_xxx` and `?lineage=N_xxx` are mutually exclusive (400 if both given); `?lineage` uses `GraphLogic.getLineage()` (ancestors + descendants + spouses). Events whose `location` lacks `lat`/`lng` are skipped.
- **No persisted data changes** — reads from already-geocoded `lat`/`lng` on Place objects (populated by GeocodingService, Phase 3.15) plus `end_date`/`sort_end_date` (added in Schema 5.1).
- **Response cache**: a 32-entry in-memory LRU keyed by scope (`'all:_'`, `'person:N_xxx'`, or `'lineage:N_xxx'` — derived from the route's mutually-exclusive `?person` xor `?lineage` querystring) short-circuits repeated `forEachNode` walks. The cache is invalidated wholesale by subscribing to `GraphEngine`'s `'graph-updated'` event, which fires after every hydration completion and every successful hot-patch. A monotonic generation counter guards against an in-flight request memoizing a stale response after a mid-computation invalidation: `myGen = gen` at request start; `cache.set(...)` only if `myGen === gen` at request end. Worst-case freshness is bounded by hot-patch latency (≤ a few hundred ms); LRU bound prevents unbounded growth across many distinct focal ids.
- **Tests**: `tests/api/MapEvents.test.ts` covers — (a) `200` with no params returns all geocoded events, (b) `400` when `person` and `lineage` are both passed, (c) `404` when an unknown id is passed, (d) bbox math is correct over a fixture, (e) undated events are included in `events` but excluded from `extent.minDate`/`maxDate`, (f) cache invalidation fires when a hot-patch updates a person's events.

#### Deep-link contract

`/map?scope=focal&person=N_xxx&t=1880&t_end=1900&g=decade&speed=2&loop=1&play=1&event=<eventId>` — full state round-trips. The URL is updated via `navigate({ replace: true })` when stores change (debounced 200 ms), with `?event=` written/cleared synchronously on drawer open/close. `?t=&t_end=` boot through `seedWindowFromUrl()`, which marks the window as seeded — without that, the extent init after the first data load would overwrite the deep-linked window with the default seed. When `?event=<id>` is present and the events query has resolved, the matching event opens in the EventDrawer **once on mount** (not on every `search.event` change — closing the drawer would otherwise cause the effect to re-open it).

#### Empty-state and loading-state

- **Loading**: while the events query is pending, a translucent overlay reads "Loading events…" centered on the map.
- **Empty**: when `events.data.events.length === 0`, an inline card overlays the map with "No events with coordinates yet" and a link to `/settings` → Geocoding.

#### Mobile (< 768 px)

- The map's TopBar action cluster (scope buttons, focal-person picker, event-type filter) stays in the global TopBar and **wraps onto additional rows** when it doesn't fit: the shared TopBar action slot uses `flex-wrap` and the bar grows via `min-h` (not a fixed height), so the controls reflow to a new line rather than overflow the viewport on narrow screens.
- Time slider stays bottom-docked.
- **Event drawer is a 40 vh bottom sheet (`h-[40vh]`) with a swipe-down handle** — a small horizontal pill at the top of the drawer, draggable; pointer-down + drag-down ≥ 80 px dismisses the drawer (`DISMISS_THRESHOLD = 80` in `EventDrawer.tsx`). Implemented as a plain positioned `aside` (no Radix Dialog) using Pointer Events with `setPointerCapture` so the drag tracks past element boundaries.

#### Nav + palette

Sidebar Globe icon links to `/map`. Command palette (`/` hotkey) includes "View Map" and (when a focal is set) "Show focal lineage on Map".

#### File layout

```
client/src/features/map/
  MapView.tsx          Top-level component
  MapToolbar.tsx       Map's TopBar action cluster (portaled via TopBarActions):
                       scope buttons (Everyone / Focal person / Focal lineage),
                       the shared FocalPersonPicker, and the collapsible
                       "Event types" filter popover that doubles as the legend.
                       (No separate MapLegend component — superseded by this popover.)
  TimeSlider.tsx       Dual-handle Radix slider + playback controls
  EventDrawer.tsx      Side drawer (desktop) / 40 vh bottom sheet (mobile);
                       list mode for co-located events + single-event card
  api.ts               useMapEvents React Query hook
  constants.ts         BASEMAP_MAX_ZOOM (single source of truth for ctor + fitBounds caps)
  eventTypes.ts        EVENT_TYPES, EventType, TYPE_COLORS, TYPE_WEIGHTS registry
  prefsStore.ts        Persisted Zustand store (scope, g, speed, loop, eventTypes)
  timeStore.ts         In-memory Zustand store (window, extent, extentSeeded, …)
  types.ts             MapEvent, MapEventsResponse, Granularity, Scope, Speed
  layers/
    buildMapLayers.ts  Pure builder (renamed from useMapLayers — not a hook);
                       prepareEvents, GPU time-filter encoding (getTimeFilterValue,
                       timeFilterRange, YEAR_SENTINEL)
    FilteredHeatmapLayer.ts  HeatmapLayer subclass fixing DataFilterExtension
                       support (see its header comment)
  styles/
    themedStyle.ts     themedStyle(theme): StyleSpecification — single source
                       of truth for layer structure; day.ts and night.ts
                       are one-line wrappers calling themedStyle('light'|'dark').
    day.ts             dayStyle = () => themedStyle('light')
    night.ts           nightStyle = () => themedStyle('dark')
client/public/
  basemap/             countries.json, country-labels.json, states.json,
                       state-labels.json, lakes.json, places.json,
                       graticules.json
  fonts/Open Sans Regular/  256 PBF glyph ranges
scripts/
  buildBasemap.ts      One-shot build script for basemap GeoJSON (devs only)
  buildBasemapFonts.ts One-shot script that vendors Open Sans Regular PBFs
                       from openmaptiles/fonts gh-pages (devs only)
src/api/routes/
  map.ts               GET /api/map/events with LRU cache
tests/api/MapEvents.test.ts                                    backend route (LRU cache, validation, bbox math)
tests/e2e/map-snapshots.spec.ts                                visual regression harness (10 baselines, run via `npm run test:visual`)
client/src/features/map/styles/styles.test.ts                  light/dark layer-shape contract (required for setStyle({diff:true}))
client/src/features/map/layers/buildMapLayers.test.ts          layer ids/visibility, crossfade band, focal-path halo+stroke ordering, jitter determinism
client/src/features/map/timeStore.test.ts                      granularity-sized seed, no-reset on subsequent calls, isEventInWindow cases
playwright.config.snapshots.ts                                 separate config for visual harness — assumes running dev servers
tests/e2e/map-perf.spec.ts                                     zoom-perf trace harness (scripted zoom via window.__map, DevTools profiles)
playwright.config.perf.ts                                      separate config for the perf harness — run manually, not in CI
tests/e2e/map.spec.ts                                          user-flow E2E (not yet written — deferred until UX polish settles)
```

#### Explicit non-goals

The Map View is deliberately bounded. The following are **not** part of v1 and proposals to add them should be weighed against the "global overview, not street atlas" framing:

- **Street-level rendering.** The basemap stops at country/admin-1/major-city detail by design. Streets, buildings, and POIs add visual noise that competes with the event data.
- **3D globe projection.** MapLibre v5 supports it; we chose flat Mercator for clarity and rendering performance.
- **Historical basemaps** (e.g., 1800-era political boundaries that follow the time slider). Genuinely valuable but out of scope; would require a per-decade tile pipeline.
- **Collateral lineage** (siblings, cousins, in-laws beyond direct spouses). The "Focal lineage" scope is intentionally narrow — direct ancestors + direct descendants + spouses only — to keep the migration story readable.
- **Shareable playback recordings** (GIF/MP4 export of a playback session). Worth considering later; not v1.
- **User-uploaded basemap layers** (custom polygons, historical map overlays). Out of scope for v1.

---

### **6.12 Settings Page — Git History & Recovery** *(not yet implemented — Phase 5.8)*

The Settings page is the primary surface for the git history/recovery UX. It is restructured into four sections:

#### **Section 1 — System Status** *(existing, extended)*
Existing cards (hydration state, node count, edge count, cache age) plus:
- Heap usage mini progress bar: `[====----] 42 MB / 120 MB` — turns amber/red when `heapWarning: true` (>75% of heap limit).
- `hydrationDurationMs`: "Last hydration: 1.2s" (muted).
- `cacheHitRatio`: "Cache: 94% hit" (muted).

#### **Section 2 — Git Status**
Backed by `useGitStatus()` hook → `GET /api/system/git-status`. Polls every 5s when dirty/pending, 30s when clean.

- **Branch badge**: `GitBranch` icon + branch name (monospace, max 16 chars, truncated with `…`).
- **State badge**: Green "Clean" / Amber "Dirty" / Amber "N pending" (when `hasPending: true`).
- **Pending files list** (collapsible, shown when `hasPending: true`): human-readable labels from `pendingFiles[]` — e.g., "Johann Bach", "Anna Magdalena Bach". Helps the user understand what is queued before pressing "Commit Now".
- **Last commit line**: `{message} — {relative time}  [{shortHash}]` (muted text below the badges).
- **"Commit Now"** button + optional `<Input>` for a custom commit message. Button disabled when `!hasPending`. Calls `POST /api/system/commit` with optional `{ message }`. On success, invalidates `gitStatus` and `gitLog` queries and shows a success toast.

#### **Section 3 — History Log**
Backed by `useGitLog({ limit: 20, offset })` → `GET /api/system/git-log`. Paginated.

- Paginated list (20/page) of commits.
- Each **row**: short hash (monospace), commit message (truncated), relative time, file count. Rows are expandable.
- **Expanded row** (lazy-fetches `GET /api/system/git-log/:hash` on first open):
  - Per-file list with `+` (added, emerald), `M` (modified, amber), `-` (deleted, red) prefix and file path.
  - If `truncated: true`, shows `"...and {N - 50} more files"`.
  - **"Restore to this commit"** button → opens `RestoreDialog` in `scope: 'full'` mode.

#### **Section 4 — Snapshots**
Backed by `useSnapshots()` → `GET /api/system/snapshots`.

- **"New Snapshot"** button: opens snapshot dialog with name field + optional `description` field. Calls `POST /api/system/snapshot`.
- **Snapshot grid**: cards sorted newest-first. Each card shows:
  - Snapshot name (bold)
  - Creation date (formatted)
  - Linked commit: short hash (monospace badge) + first line of commit message (muted, truncated)
  - **"Restore"** button → opens `RestoreDialog` in `scope: 'full'` mode with `ref: snapshot.name`.
  - **"Delete"** button (destructive icon) → `DELETE /api/system/snapshots/:name` with confirmation toast.

#### **`RestoreDialog` component** (`client/src/shared/components/RestoreDialog.tsx`)
Shared by both the History Log and Snapshots sections, and by the Person Detail History tab:

- **`scope: 'full'`** — full-repo restore:
  > "This will restore ALL files to the state at `[commit/tag]` from `[time]`. Uncommitted changes will be lost. The repository will enter detached HEAD state. The graph will be rebuilt automatically."
  > [Cancel] · [Restore to this commit]

  Post-restore: server returns `{ rebuildTriggered: true }`, frontend navigates to `/` (Dashboard), `HydrationProgress` overlay re-appears.

- **`scope: 'person'`** — single-person restore:
  > "This is **safe**: a new commit will be created with the restored data. Your commit history is fully preserved."
  > Shows a **semantic diff preview** (fetched from `GET /api/system/git-log/:hash`): field-level comparison of the current vs. target YAML (name, event count, asset count — not line-by-line diff). Aimed at non-technical users.
  > [Cancel] · [Restore this person]

  Post-restore: `queryClient.invalidateQueries(['person', personId])` — no full rebuild.

#### **Person Detail — History Tab** (`client/src/features/people/PersonDetailPage.tsx`)
A 4th tab added to the right Context Panel alongside Assets / Notebook / Raw YAML:

- Backed by `usePersonHistory(personId, { limit: 10, offset })` → `GET /api/people/:id/history`.
- Compact commit list (10/page; sized for the narrow panel).
- Each entry: short hash (monospace), semantic commit message, relative time.
- **"Restore this version"** button per entry → opens `RestoreDialog` in `scope: 'person'` mode.
- Simple `Newer` / `Older` pagination buttons (no full pagination component — panel is too narrow).

#### **Sidebar Dirty Indicator** (update to Section 6.2.2)
The Settings sidebar entry is enhanced:
- Shows current branch name (muted monospace, truncated at 16 chars) when sidebar is expanded.
- Shows an amber `•` dot when `gitDirty: true`.
- In icon-only mode: amber dot badge on the Settings gear icon.
- Data sourced from the shared `useGitStatus()` TanStack Query cache — no extra API calls, no prop drilling.

---

### **6.14 Private Mode & Guest Mode** *(not yet implemented — Phase 5.6)*

- **Private toggle**: Each person has a `private: boolean` field (default `false`). Set via the lock icon badge in the Identity Panel.
- **Authenticated view** (normal): All people visible regardless of `private` flag.
- **Guest Mode**: When no valid JWT is present (unauthenticated request) and auth is configured:
  - Persons with `private: true` are **excluded** from `GET /api/people` list responses.
  - `GET /api/people/:id` for a private person returns `404` (not `403`) to avoid revealing existence.
  - Search results exclude private persons.
  - Force Graph, Fan Chart, and Pedigree Chart nodes for private persons are hidden or replaced with "Private" placeholder nodes.
- **"Living Surname" anonymization** (Phase 6+): For living persons (no death event) marked private, display only last name with a "Living" prefix (e.g., "Living Smith") in public/guest contexts.

---

### **6.15 New API Endpoints Required**

In addition to the endpoints in Section 6.10, the following new backend endpoints are needed:

| Method | Path | Purpose |
|:-------|:-----|:--------|
| `GET` | `/api/stories` | Paginated list of all stories (`StoryFeedItem[]`) |
| `GET` | `/api/stories/:id` | Full story — frontmatter + body Markdown |
| `POST` | `/api/stories` | Create new story (writes Markdown file) |
| `PUT` | `/api/stories/:id` | Update story body + frontmatter |
| `DELETE` | `/api/stories/:id` | Delete story file |
| `PUT` | `/api/stories/:id/media` | Attach asset to story (multipart) |
| `GET` | `/api/assets` | List all `/assets` files with referencing people/stories |
| `GET` | `/api/system/git-status` | Enhanced git status (see Section 7.2): `{ branch, dirty, pendingFiles[], hasPending, lastCommit }` |
| `POST` | `/api/system/commit` | Flush TransactionManager immediately with optional message override (see Section 7.2) |
| `GET` | `/api/system/git-log` | Paginated commit history `?limit&offset` → `{ commits[], totalCount }` (see Section 7.2) |
| `GET` | `/api/system/git-log/:hash` | Single commit detail with per-file before/after content (see Section 7.2) |
| `GET` | `/api/system/snapshots` | List all git tags / snapshots (see Section 7.2) |
| `DELETE` | `/api/system/snapshots/:name` | Delete a snapshot tag (see Section 7.2) |
| `POST` | `/api/system/restore` | Restore to commit or snapshot — full or single-person scope (see Section 7.2) |
| `GET` | `/api/people/:id/history` | Path-filtered commit log for a single person's YAML file (see Section 7.2) |

---

### **6.16 Technical Constraints (Mandatory)**

These constraints are non-negotiable for any data-dense genealogy UI:

1.  **Virtualization is Mandatory**: The Timeline Feed, Search Results, and People Browse table must use virtual scrolling (`@tanstack/react-virtual`). DOM nodes are only rendered for visible items. This is critical for datasets with thousands of events or search results.
2.  **Optimistic UI with TanStack Query**: Because the backend uses a debounced Git queue (Section 7.1), writes have slight latency. The React UI must use optimistic updates: update local React Query cache immediately on user action, send the `PUT`/`POST`, and only roll back if the API returns an error. Toast notifications (Sonner) confirm success or show rollback errors.
3.  **Hydration-Aware Shell**: The app shell must handle the 503 loading gate gracefully. On boot, connect to `GET /system/hydration/stream` (SSE) and display `HydrationProgress` overlay. Do not render data-dependent views until `hydrationState === "ready"`.
4.  **Typed API Client**: A shared `client/src/shared/api/` layer with typed fetch wrappers for every backend endpoint. Types shared or mirrored from the backend Zod schemas to ensure compile-time safety.
5.  **Responsive Design**: All pages must function on desktop (≥1280px), tablet (768px–1279px), and mobile (<768px) viewports. The sidebar, Holy Grail panels, and tables adapt as specified in 6.2.2 and 6.5.1.

### **6.17 API Additions Required for Frontend (Original)**

The following backend additions are needed to support the core frontend views. See Section 6.15 for the full extended list including Stories, Assets, and Git status endpoints.

- **`GET /api/people`**: Paginated list of all people (slim summaries). Query params: `?limit=50&offset=0&sort=last_modified&order=desc`. Returns `{ people: SlimPersonSummary[], totalCount: number }`. Each summary: `{ id, names, sex, birthDate?, deathDate?, tags, assetCount, primaryAsset? }`. `primaryAsset` is the first entry from `assets[]`, used for photo display on the People Browse page.
- **`GET /api/stats`** (or extend `GET /system/status`): Dashboard stats — total people, total families (marriage event count), last modified timestamp.

---

## **7. Operational & Security Layer**

### **7.1 Git Operations**

- **Middleware**: "Auto-Commit". Every write operation (`PUT`, `POST`) results in a Git commit that captures the change.

**Debounced Commit Queue**:

The `TransactionManager` uses `isomorphic-git` (pure JavaScript, in-process) for all programmatic Git operations, avoiding child-process overhead:

- **Commit Window**: File writes are queued. After the last write in a burst, a **5-second debounce timer** starts. When the timer fires, all pending changes are committed in a single atomic Git commit via `isomorphic-git`.
- **Commit Message**: Semantic, operation-aware. `TransactionManager` accepts an optional `OperationHint` on each write that produces context-specific messages:
  ```typescript
  type OperationKind = 'create_person' | 'update_person' | 'upload_media' | 'delete_media'
                     | 'import_gedcom' | 'create_story' | 'update_story' | 'delete_story' | 'generic';
  interface OperationHint { kind: OperationKind; subject: string; detail?: string; count?: number; }
  ```
  - `create_person` → `"Add person: Johann Sebastian Bach (1685)"`
  - `update_person` → `"Update person: Anna Bach — events, relationships"`
  - `upload_media` → `"Upload photo for: Johann Bach"`
  - `delete_media` → `"Remove photo from: Johann Bach"`
  - `import_gedcom` → `"Import 47 people from Bach-Family.ged"`
  - `create_story` / `update_story` / `delete_story` → `"Add/Update/Delete story: {title}"`
  - Batches with mixed operation kinds fall back to: `"Update N files: Person X, ..."` (72-char truncated).
  - `flush(messageOverride?)` accepts an optional user-supplied message (wired to the "Commit Now" button in Settings).
- **Flush on Demand**: The API exposes a mechanism to force an immediate flush (e.g., before a snapshot or on graceful shutdown), bypassing the debounce window.
- **Graceful Shutdown Flush**: Node process `SIGTERM`/`SIGINT` signals are trapped. The application blocks shutdown until `TransactionManager.destroy()` finishes flushing any buffered `isomorphic-git` commits, preventing data loss.
- **Mutex Retained**: The global Mutex still protects concurrent write access to the file system. The debounce only affects when `git commit` is invoked, not when files are written.
- **Extended Public API**:
  - `getPendingLabels(): string[]` — returns human-readable labels of all queued writes (exposed by `GET /api/system/git-status` to show the pending file list to the user).
  - `setBatchHint(hint: OperationHint): void` — stamps all currently-queued writes with a single bulk hint (used by GEDCOM import to collapse N individual file writes into one message: `"Import 47 people from Bach-Family.ged"`).
  - `flush(messageOverride?: string): Promise<void>` — extended to accept an optional user-supplied commit message, overriding the auto-generated message for that single flush operation.

**isomorphic-git (Complete — Phase 3.6)**:

- **Status**: ✅ Complete. All programmatic Git operations (`add`, `commit`, `tag`, `log`) use `isomorphic-git`, a pure JavaScript Git implementation running entirely in the Node.js process. No child processes are spawned for Git operations.
- **Rationale**: The previous `simple-git` approach shelled out to the OS Git binary for every operation, incurring process-spawn overhead. `isomorphic-git` eliminates this entirely.
- **Scope**: The user's system Git remains available for manual CLI use and is unaffected.
- **Tradeoff**: `isomorphic-git` does not support every Git feature (e.g., advanced merge strategies). For operations like `push`/`pull` (future network sync), fall back to spawning system Git.

### **7.2 Git History & Recovery**

The git history is surfaced as a first-class, actionable feature. Users can browse the commit log, inspect what changed, and restore to any previous state — all from within the app.

**New API Endpoints** (all in `src/api/routes/system.ts` unless noted):

| Method | Path | Description |
|:-------|:-----|:------------|
| `GET` | `/api/system/git-status` | Enhanced: `{ branch, dirty, pendingFiles: string[], hasPending, lastCommit: { hash, fullHash, message, author, timestamp } \| null }` |
| `POST` | `/api/system/commit` | Flush `TransactionManager` immediately; optional `{ message? }` body overrides auto-generated message → `{ committed: bool, hash, timestamp }` |
| `GET` | `/api/system/git-log` | Paginated commit history — `?limit=20&offset=0` → `{ commits[], totalCount, offset, limit }`. Each commit: `hash`, `fullHash`, `message`, `author`, `timestamp`, `filesChanged: number \| null` |
| `GET` | `/api/system/git-log/:hash` | Single commit detail: full message, author, email, timestamp, and per-file `{ path, status: 'added'\|'modified'\|'deleted', before: string\|null, after: string\|null }` content via `git.readBlob`. Binary assets: `{ isBinary: true }`. Commits with >50 changed files: `{ truncated: true, totalFiles: N }` |
| `GET` | `/api/system/snapshots` | List all git tags → `{ snapshots: [{ name, message, taggerName, timestamp, targetCommit: { hash, fullHash, message, timestamp } }] }`, sorted newest-first |
| `DELETE` | `/api/system/snapshots/:name` | Delete a snapshot tag → `204 No Content`. Auth required. `404 SNAPSHOT_NOT_FOUND` if missing. |
| `POST` | `/api/system/restore` | Restore to a ref. Body: `{ ref: string, scope: 'full'\|'person', personId?: string, confirm: true }`. `confirm` must be `true` → `400 CONFIRM_REQUIRED` otherwise. |
| `GET` | `/api/people/:id/history` | Path-filtered commit log for a single person's YAML file. Same pagination shape as `git-log`. Lives in `src/api/routes/people.ts`. |

**`GET /api/system/git-status` implementation notes**:
- `branch`: `git.currentBranch()` — returns `null` for detached HEAD (shown as `"HEAD"` in the UI).
- `dirty`: `git.statusMatrix()` — any file with a tuple other than `[1,1,1]` (tracked+unchanged) sets `dirty: true`.
- `pendingFiles`: `txManager.getPendingLabels()` — labels of writes not yet committed.
- `lastCommit.timestamp`: isomorphic-git uses Unix seconds (`commit.author.timestamp * 1000` for `Date`).
- Non-git repo: returns `{ branch: null, dirty: false, pendingFiles: [], hasPending: false, lastCommit: null }` — not an error.
- **503 gating**: `git-status` and `system/commit` are NOT 503-gated (always available, like `GET /system/status`).

**`POST /api/system/restore` — two scopes**:

- `scope: 'full'`: `git.checkout({ ref, force: true })` restores the entire working directory to the target state. Enters detached HEAD (the frontend shows a prominent warning and offers to create a new branch). Triggers full graph hydration rebuild via `graphEngine.hydrateInBackground()`. The `HydrationProgress` overlay re-appears automatically (server sets `hydrationState: 'loading'`). Pending writes are flushed first.
- `scope: 'person'`: reads the person's YAML blob at the target commit via `git.readBlob` + a `resolveBlobAtCommit(dir, commitOid, filePath)` helper (walks commit tree to resolve blob OID), then writes the content back via `TransactionManager.writeFile()`. This creates a new **forward commit** — linear history preserved, no `git reset`. Only hot-patches the single person node; no full rebuild needed. Commit message: `"Update person: {name} (restored from {shortHash})"`.

**`GET /api/people/:id/history` algorithm**: Walk git log from HEAD (capped at 1000 commits). For each commit, compare the person's blob OID against the parent commit's blob OID via `resolveBlobAtCommit`. Include only commits where the OID changed. `O(n)` in commit count — acceptable at genealogy-dataset scales.

---

### **7.3 Authentication**

- **Local-First Auth**:
  - Credentials stored in `/_meta/auth.yaml` (BCrypt).
  - JWT Session (HttpOnly Cookie).

---

## **8. Implementation Roadmap**

Implementation status, phase-by-phase progress, and the detailed task backlog are tracked in **`PROGRESS.md`**.

This spec defines _what_ to build. `PROGRESS.md` tracks _how far_ and _what's next_.

---

## **9. Comprehensive Test Strategy**

### **9.1 Unit Tests (Vitest)**

*   **GEDCOM**: Verify parsing of 5.5.1 and 7.0 specific tags. Verify export round-trip preserves `_gedcom` tags.
*   **Search**: Verify fuzzy matching for typos in names. Verify pagination (`limit`, `offset`) returns correct slices and `totalCounts`.
*   **Timeline**: Verify Gap Detection logic. Verify pagination returns correct slices with `totalCount`.
*   **Schemas**: Verify Zod schemas reject invalid data and accept new fields (`scrapbook_md`, `_gedcom`).
*   **Computed Cache (`_computed`)**: Verify `computeRelationships()` populates correct spouse, sibling, and children data. Verify invalidation recomputes only affected nodes and neighbors.
*   **Edge Reconciliation**: Verify diff-based patching adds/removes exact edges for parent and marriage changes without touching unrelated edges.
*   **Graph Cache**: Verify cache hit skips YAML parsing. Verify stale `mtime` triggers selective re-parse. Verify missing/corrupt cache triggers full Nuclear Hydration.
*   **TransactionManager**: Verify debounced batching collapses rapid writes into a single commit. Verify flush-on-demand bypasses the debounce window. Verify `isomorphic-git` operations run in-process (no child-process spawning). Verify `OperationHint` produces semantic commit messages for all `OperationKind` values. Verify `getPendingLabels()` returns human-readable labels. Verify `setBatchHint()` stamps all pending writes. Verify `flush(messageOverride)` uses the supplied message.
*   **SearchService Hot-Patch**: Verify incremental index update on node change. Verify index removal on node unlink.
*   **Worker Thread Hydration**: Verify worker function produces identical people/story output as inline BootLoader. Verify `hydrateInBackground()` completes and populates graph to same state as `hydrate()`. Verify `hydrationState` transitions correctly. Verify API returns 503 during loading for non-exempt endpoints.
*   **File Watcher (`@parcel/watcher`)**: Verify watcher detects add, change, unlink events for both `people/` and `stories/` directories. Verify subscription cleanup on shutdown. Verify story creation adds graph node with mentions edges. Verify story update refreshes metadata and edges. Verify story deletion removes node and edges from graph + search index.
*   **Slim Node Strategy**: Verify `scrapbook_md` and `_gedcom` are stripped from in-memory Graphology node `data` attribute after hydration. Verify graph cache serializes only slim data. Verify `GET /people/:id` returns full data (including `scrapbook_md` and `_gedcom`) by lazy-loading from disk. Verify search indexing still works without `scrapbook_md` in memory (bio field sourced during indexing, not from node attribute).
*   **Search Index Persistence**: Verify `SearchService.export()` serializes index to `/_meta/.search-index.json`. Verify `SearchService.import()` loads pre-compiled index and produces identical search results. Verify incremental boot only re-indexes nodes with changed `mtime`. Verify corrupt/missing index triggers full rebuild. Verify `spec_version` mismatch triggers full rebuild.
*   **Search Performance**: Verify `trackedPersonIds` and `trackedStoryIds` use `Set<string>` semantics (O(1) add/has). Verify FlexSearch limit bounds engine output correctly for paginated queries.
*   **Write-Event Deduplication**: Verify API-initiated writes register file path in the write-origin set. Verify file watcher skips hot-patch for self-written files (consumes entry from set). Verify external edits (not in write-origin set) are processed normally. Verify write-origin entries expire after TTL.

### **9.2 Integration Tests (Supertest)**

*   **Media Upload**: Test multipart upload -> FS write -> YAML update.
*   **Snapshots**: Trigger snapshot → verify git tag exists. Verify pending commits flushed before tagging. Verify `GET /system/snapshots` lists the tag. Verify `DELETE /system/snapshots/:name` removes the tag (204). Verify 404 for missing snapshot name.
*   **Git History API** (`tests/api/GitHistory.test.ts`): `GET /system/git-status` — branch, dirty, pending, lastCommit. `GET /system/git-log` — pagination, empty repo graceful. `GET /system/git-log/:hash` — file before/after, 404 for unknown hash. `POST /system/commit` — flushes pending, uses custom message, no-op when nothing pending. `POST /system/restore` — 400 without `confirm: true`, person-scope creates forward commit, person-scope 404 for unknown personId. `GET /api/people/:id/history` — correct commits returned, pagination, 404 for missing person.
*   **Graph Hydration**: Verify `BootLoader` correctly populates the `GraphEngine`.
*   **API `_computed` Contract**: Verify `GET /people/:id` returns pre-computed relationships without triggering on-the-fly traversal.
*   **System Status**: Verify `GET /system/status` returns accurate node/edge counts and hydration state.
*   **System Rebuild**: Verify `POST /system/rebuild` invalidates cache and triggers full re-hydration.
*   **Hydration SSE Stream**: Verify `GET /system/hydration/stream` sends `progress` events during loading and a `complete` event when finished. Verify immediate `complete` if already hydrated.
*   **Search Pagination**: Verify `GET /search?q=...&limit=10&offset=5` returns correct paginated slices with `totalCounts`.
*   **API Write Side Effects**: Verify `POST /people` indexes new person in search immediately. Verify `POST /people` with parents wires parent edges in graph and populates `_computed.children` on parent. Verify `PUT /people/:id` updates search index with new name. Verify `PUT /people/:id` with marriage event recomputes `_computed.currentSpouse` for neighbors.
*   **Authentication**: Verify login returns HttpOnly JWT cookie. Verify protected endpoints reject unauthenticated requests. Verify logout clears session.

### **9.3 E2E Tests (Playwright)**

*   **CUJ: Import Flow**: Upload GEDCOM -> Wait for Hydration -> Verify Node Count. ✅ Complete.
*   **CUJ: Holy Grail (Import → View → Edit → Persist)**: Upload GEDCOM → navigate to person → edit name → reload → assert persisted. ✅ Complete.
*   **CUJ: Search Navigation**: Cmd+K → type query → click result → assert navigation. ✅ Complete.
*   **CUJ: Responsive Layout**: Mobile viewport → hamburger → expand sidebar. Desktop → sidebar visible. ✅ Complete.

### **9.4 New Unit Tests Required (Phases 3.11–3.15)**

*   **ID Generator**: `generatePersonId()` correctness for name slugification, missing fields, diacritics, uniqueness, file-name collision fallback.
*   **Auto-ID Watcher**: Dropping YAML without `id` triggers generation, YAML rewrite, and file rename.
*   **GeocodingService**: Known city returns lat/lng; cache hit skips HTTP; rate limiter fires; fallback on failure; historical name preservation.
*   **Place Schema**: String location coerces to `{ name }` on parse; full Place object round-trips; invalid Place rejected.
*   **DateParser Audit**: All fuzzy modifier cases (`BET`, `BEF`, `AFT`, `ABT`, `EST`, `CAL`, year-only, month-year).
*   **Asset Deletion API**: `DELETE /people/:id/media/:filename` — 204, file gone, YAML updated; 404 for missing person; 404 for filename not in assets.
*   **Timeline Slicer (undated)**: Undated events appear before dated events; `unknown_date_header` item present; dated events retain correct order.

