import { Document } from 'flexsearch';
import Graph from 'graphology';
import * as fs from 'fs/promises';
import { Person, SlimPerson } from '../schemas/PersonSchema';
import { Story } from './StoryLoader';
import { CACHE_SPEC_VERSION } from './GraphCache';
import { formatPlaceDisplay } from '../schemas/PlaceSchema';

export interface SearchResult {
    id: string;
    type: 'person' | 'story';
    name: string;
    snippet?: string;
}

export interface PlaceResult {
    location: string;
    count: number;
}

export interface PaginationOptions {
    limit?: number;  // Default: 50, max: 200
    offset?: number; // Default: 0
}

export interface SearchResponse {
    people: SearchResult[];
    stories: SearchResult[];
    places: PlaceResult[];
    totalCounts: {
        people: number;
        stories: number;
        places: number;
    };
}

interface PersonIndexDoc {
    id: string;
    fullName: string;
    names: any[];
    bio: string;
    locations: string;
    [key: string]: any;
}

interface StoryIndexDoc {
    id: string;
    title: string;
    place: string;
    content: string;
    [key: string]: any;
}

export class SearchService {
    private personIndex: Document<PersonIndexDoc, true>;
    private storyIndex: Document<StoryIndexDoc, true>;
    private placeMap: Map<string, Set<string>> = new Map(); // location -> set of personIds

    private persistencePath: string | null = null;
    private persistTimeout: NodeJS.Timeout | null = null;
    private persistInFlight: Promise<void> | null = null;
    private readonly debounceMs = 500;

    constructor() {
        this.personIndex = new Document({
            document: {
                id: "id",
                index: [
                    "fullName",
                    "names:first",
                    "names:last",
                    "names:nickname",
                    "bio",
                    "locations"
                ],
                store: true
            },
            tokenize: "forward"
        });

        this.storyIndex = new Document({
            document: {
                id: "id",
                index: ["title", "place", "content"],
                store: true
            },
            tokenize: "forward"
        });
    }

    /**
     * Reset both indices to fresh empty instances (clears all stale entries).
     */
    private resetIndices(): void {
        this.personIndex = new Document({
            document: {
                id: "id",
                index: ["fullName", "names:first", "names:last", "names:nickname", "bio", "locations"],
                store: true
            },
            tokenize: "forward"
        });
        this.storyIndex = new Document({
            document: {
                id: "id",
                index: ["title", "place", "content"],
                store: true
            },
            tokenize: "forward"
        });
    }

    /**
     * Completely rebuilds all indices from the Graph.
     * Called on Hydration. Resets indices first to remove stale entries.
     */
    public async rebuild(graph: Graph): Promise<void> {
        this.resetIndices();
        this.placeMap.clear();

        graph.forEachNode((node, attributes) => {
            if (attributes.type === 'person') {
                this.indexPerson(attributes.data as Person, undefined, true);
            } else if (attributes.type === 'story') {
                this.indexStory(attributes.data as Story, true);
            }
        });

        this.debouncePersist();
    }

    /**
     * Sets the path where the search index should be persisted.
     */
    public setPersistencePath(filePath: string) {
        this.persistencePath = filePath;
    }

    /**
     * Debounces internal index persistence to avoid heavy I/O during hot-patches.
     */
    private debouncePersist() {
        if (!this.persistencePath) return;

        if (this.persistTimeout) clearTimeout(this.persistTimeout);

        this.persistTimeout = setTimeout(() => {
            this.persistTimeout = null;
            this.persistNow();
        }, this.debounceMs);
    }

    private persistNow(): Promise<void> {
        if (!this.persistencePath) return Promise.resolve();
        const write = this.exportIndex(this.persistencePath)
            .catch(err => console.error('[SearchService] Failed to persist index: ', err))
            .finally(() => {
                if (this.persistInFlight === write) this.persistInFlight = null;
            });
        this.persistInFlight = write;
        return write;
    }

    /**
     * Write any debounced index change now and cancel the timer, then wait for an
     * in-flight write. Call on shutdown so the latest index isn't lost and nothing
     * writes into the data dir afterwards.
     */
    public async flushPendingPersist(): Promise<void> {
        if (this.persistTimeout) {
            clearTimeout(this.persistTimeout);
            this.persistTimeout = null;
            await this.persistNow();
        }
        if (this.persistInFlight) await this.persistInFlight;
    }

    /**
     * Index or update a person in the search index and place map.
     * Removes stale entries first to prevent ghost matches.
     *
     * @param p - Person or SlimPerson data
     * @param bio - Scrapbook markdown for bio indexing. If omitted, falls back to
     *              p.scrapbook_md (when p is a full Person) or empty string (when p is SlimPerson).
     */
    public indexPerson(p: Person | SlimPerson, bio?: string, skipPersist = false) {
        // Remove old place entries for this person
        this.removePersonPlaces(p.id);

        // Remove old search entry (prevents stale matches on name change)
        try { this.personIndex.remove(p.id); } catch { /* might not exist */ }

        // Flatten locations for full-text search
        const locations = p.events
            .map(e => [e.location?.name, e.site_name].filter(Boolean).join(' '))
            .filter(Boolean)
            .join(" ");

        const bioText = bio ?? ((p as any).scrapbook_md || '');

        // Build a composite full-name string so multi-word queries like "Helen Tan"
        // match across first + last name fields (FlexSearch searches each field independently).
        const fullName = p.names
            .map((n: any) => `${n.first || n.given || ''} ${n.last || n.surname || ''}`.trim())
            .join(' ');

        this.personIndex.add({
            id: p.id,
            fullName,
            names: p.names,
            bio: bioText,
            locations: locations
        });

        // Update place map
        this.extractPlaces(p as Person);
        this.trackPerson(p.id);

        if (!skipPersist) this.debouncePersist();
    }

    /**
     * Remove a person from the search index and place map.
     */
    public removePerson(id: string, skipPersist = false) {
        try { this.personIndex.remove(id); } catch { /* might not exist */ }
        this.removePersonPlaces(id);
        this.untrackPerson(id);

        if (!skipPersist) this.debouncePersist();
    }

    /**
     * Index a story in the search index.
     */
    public indexStory(story: Story, skipPersist = false) {
        try { this.storyIndex.remove(story.id); } catch { /* might not exist */ }

        this.storyIndex.add({
            id: story.id,
            title: story.metadata.title,
            place: formatPlaceDisplay(story.metadata.place) || '',
            content: story.content
        });
        this.trackStory(story.id);

        if (!skipPersist) this.debouncePersist();
    }

    /**
     * Remove a story from the search index.
     */
    public removeStory(id: string, skipPersist = false) {
        try { this.storyIndex.remove(id); } catch { /* might not exist */ }

        if (!skipPersist) this.debouncePersist();
    }

    /**
     * Full-text search across people, stories, and places.
     * Supports pagination via optional limit/offset parameters.
     */
    public async search(query: string, options?: PaginationOptions): Promise<SearchResponse> {
        const limit = Math.min(options?.limit ?? 50, 200);
        const offset = options?.offset ?? 0;

        // Split the query into individual words so that multi-word queries like "Helen Tan"
        // work even though FlexSearch indexes fields independently. We search each word
        // separately and intersect the result sets, so only documents matching every word
        // (across any field) are returned.
        const words = query.trim().split(/\s+/).filter(Boolean);

        // Per-word FlexSearch limit: needs to be larger than the final page size to avoid
        // dropping candidates before intersection. We use 20× the page size (min 200) capped
        // at 10 000 — so a limit:50 request reads at most 1 000 candidates per word, while a
        // limit:1 000 request still caps at 10 000.
        const perWordLimit = Math.min(Math.max((offset + limit) * 20, 200), 10_000);

        // 1. Search People — one pass per word, intersect after each pass
        let peopleMap: Map<string, SearchResult> | null = null;

        for (const word of words) {
            const wordResults = await this.personIndex.searchAsync(word, { enrich: true, limit: perWordLimit });

            const wordMap = new Map<string, SearchResult>();
            wordResults.forEach(fieldResult => {
                fieldResult.result.forEach((item: any) => {
                    if (!wordMap.has(item.id)) {
                        const rawNames = item.doc.names;
                        const primary = rawNames.find((n: any) => n.primary) || rawNames[0];
                        wordMap.set(item.id, {
                            id: item.id as string,
                            type: 'person',
                            name: `${primary.first} ${primary.last}`.trim()
                        });
                    }
                });
            });

            if (peopleMap === null) {
                peopleMap = wordMap;
            } else {
                // Intersect: retain only IDs that matched this word too
                for (const id of [...peopleMap.keys()]) {
                    if (!wordMap.has(id)) peopleMap.delete(id);
                }
            }
        }

        const allPeople = Array.from((peopleMap ?? new Map()).values());

        // 2. Search Stories — same word-by-word intersection
        let storyMap: Map<string, SearchResult> | null = null;

        for (const word of words) {
            const wordResults = await this.storyIndex.searchAsync(word, { enrich: true, limit: perWordLimit });

            const wordMap = new Map<string, SearchResult>();
            wordResults.forEach(fieldResult => {
                fieldResult.result.forEach((item: any) => {
                    if (!wordMap.has(item.id)) {
                        wordMap.set(item.id, {
                            id: item.id as string,
                            type: 'story',
                            name: item.doc.title || item.id
                        });
                    }
                });
            });

            if (storyMap === null) {
                storyMap = wordMap;
            } else {
                for (const id of [...storyMap.keys()]) {
                    if (!wordMap.has(id)) storyMap.delete(id);
                }
            }
        }

        const allStories = Array.from((storyMap ?? new Map()).values());

        // 3. Search Places (case-insensitive substring match)
        // Scaling note: O(n) where n = unique locations. Bounded by location count, not people.
        // At 50K+ nodes with many unique locations, consider indexing places in FlexSearch.
        const allPlaces: PlaceResult[] = [];
        const lowerQuery = query.toLowerCase();
        for (const [location, personIds] of this.placeMap) {
            if (location.toLowerCase().includes(lowerQuery)) {
                allPlaces.push({
                    location,
                    count: personIds.size
                });
            }
        }

        // 4. Build response with totalCounts and pagination
        return {
            people: allPeople.slice(offset, offset + limit),
            stories: allStories.slice(offset, offset + limit),
            places: allPlaces.slice(offset, offset + limit),
            totalCounts: {
                people: allPeople.length,
                stories: allStories.length,
                places: allPlaces.length
            }
        };
    }

    /**
     * Search only the person index and return matching person IDs.
     * Use this instead of `search()` when only person matching is needed (e.g. tagged-person
     * filtering in stories/assets) to avoid the extra overhead of searching stories and places.
     */
    public async searchPeopleIds(query: string, limit = 1000): Promise<Set<string>> {
        const words = query.trim().split(/\s+/).filter(Boolean);
        const perWordLimit = Math.min(Math.max(limit * 20, 200), 10_000);
        let peopleMap: Map<string, true> | null = null;

        for (const word of words) {
            const wordResults = await this.personIndex.searchAsync(word, { enrich: true, limit: perWordLimit });
            const wordMap = new Map<string, true>();
            wordResults.forEach((fieldResult: any) => {
                fieldResult.result.forEach((item: any) => {
                    wordMap.set(item.id as string, true);
                });
            });
            if (peopleMap === null) {
                peopleMap = wordMap;
            } else {
                for (const id of [...peopleMap.keys()]) {
                    if (!wordMap.has(id)) peopleMap.delete(id);
                }
            }
        }

        return new Set((peopleMap ?? new Map()).keys());
    }

    /**
     * Extract unique locations from a person's events and add to the place map.
     */
    private extractPlaces(p: Person): void {
        p.events.forEach(e => {
            const locName = e.location?.name;
            if (locName) {
                if (!this.placeMap.has(locName)) {
                    this.placeMap.set(locName, new Set());
                }
                this.placeMap.get(locName)!.add(p.id);
            }
        });
    }

    /**
     * Remove a person's entries from the place map.
     */
    private removePersonPlaces(personId: string): void {
        const toDelete: string[] = [];
        for (const [location, personIds] of this.placeMap) {
            personIds.delete(personId);
            if (personIds.size === 0) {
                toDelete.push(location);
            }
        }
        toDelete.forEach(loc => this.placeMap.delete(loc));
    }

    /**
     * Export the search index to disk for persistence across boots.
     * Serializes FlexSearch person/story indexes, place map, and tracked IDs.
     */
    public async exportIndex(filePath: string): Promise<void> {
        const personExport: Record<string, any> = {};
        this.personIndex.export(function (key: string, data: any) {
            personExport[key] = data;
        });

        const storyExport: Record<string, any> = {};
        this.storyIndex.export(function (key: string, data: any) {
            storyExport[key] = data;
        });

        // FlexSearch export is synchronous — give a tick for completion
        await new Promise(r => setTimeout(r, 10));

        const placeMapSerialized: Array<[string, string[]]> = [];
        for (const [loc, ids] of this.placeMap) {
            placeMapSerialized.push([loc, Array.from(ids)]);
        }

        const data = {
            spec_version: CACHE_SPEC_VERSION,
            exportedAt: new Date().toISOString(),
            personIds: Array.from(this.trackedPersonIds),
            storyIds: Array.from(this.trackedStoryIds),
            personIndex: personExport,
            storyIndex: storyExport,
            placeMap: placeMapSerialized
        };

        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (dir) await fs.mkdir(dir, { recursive: true }).catch(() => { });
        await fs.writeFile(filePath, JSON.stringify(data), 'utf8');
    }

    /**
     * Import a previously exported search index from disk.
     * Returns the set of person IDs that were in the old index (for deletion tracking),
     * or null if the cache is invalid/missing.
     */
    public async importIndex(filePath: string): Promise<{ personIds: string[]; storyIds: string[] } | null> {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);

            if (!data || data.spec_version !== CACHE_SPEC_VERSION) return null;
            if (!data.personIndex || !data.storyIndex) return null;

            // Import person index
            for (const [key, val] of Object.entries(data.personIndex)) {
                this.personIndex.import(key, val as any);
            }

            // Import story index
            for (const [key, val] of Object.entries(data.storyIndex)) {
                this.storyIndex.import(key, val as any);
            }

            // Import place map
            if (Array.isArray(data.placeMap)) {
                this.placeMap.clear();
                for (const [loc, ids] of data.placeMap) {
                    this.placeMap.set(loc, new Set(ids));
                }
            }

            // Restore tracked IDs
            this.trackedPersonIds = new Set(data.personIds || []);
            this.trackedStoryIds = new Set(data.storyIds || []);

            return {
                personIds: data.personIds || [],
                storyIds: data.storyIds || []
            };
        } catch {
            return null;
        }
    }

    private trackedPersonIds: Set<string> = new Set();
    private trackedStoryIds: Set<string> = new Set();

    public trackPerson(id: string): void {
        this.trackedPersonIds.add(id);
    }

    public untrackPerson(id: string): void {
        this.trackedPersonIds.delete(id);
    }

    public trackStory(id: string): void {
        this.trackedStoryIds.add(id);
    }
}
