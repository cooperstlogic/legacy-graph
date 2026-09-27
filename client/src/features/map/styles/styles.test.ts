import { describe, it, expect } from 'vitest';
import type { StyleSpecification, LayerSpecification } from 'maplibre-gl';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { dayStyle } from './day';
import { nightStyle } from './night';

const EXPECTED_LAYER_IDS = [
    'background',
    'country-fill',
    'lake-fill',
    'country-boundary',
    'state-boundary',
    'graticules',
    'country-label',
    'state-label',
    'city-label',
];

const EXPECTED_SOURCES = [
    'countries',
    'country-labels',
    'states',
    'state-labels',
    'lakes',
    'places',
    'graticules',
];

describe('basemap styles', () => {
    it.each([['day', dayStyle], ['night', nightStyle]])('%s style passes style-spec validation', (_name, build) => {
        expect(validateStyleMin(build()).map((e) => e.message)).toEqual([]);
    });

    it('dayStyle returns a valid StyleSpecification', () => {
        const s = dayStyle();
        expect(s.version).toBe(8);
        expect(s.sources).toBeDefined();
        expect(s.layers).toBeDefined();
    });

    it('nightStyle returns a valid StyleSpecification', () => {
        const s = nightStyle();
        expect(s.version).toBe(8);
        expect(s.sources).toBeDefined();
        expect(s.layers).toBeDefined();
    });

    it('both styles declare the expected GeoJSON sources with relative /basemap/ URLs', () => {
        for (const s of [dayStyle(), nightStyle()]) {
            const sourceIds = Object.keys(s.sources);
            expect(sourceIds.sort()).toEqual([...EXPECTED_SOURCES].sort());
            for (const id of EXPECTED_SOURCES) {
                const src = s.sources[id] as { type: string; data: string };
                expect(src.type).toBe('geojson');
                expect(src.data).toMatch(/^\/basemap\//);
            }
        }
    });

    it('glyphs URL points to /fonts/{fontstack}/{range}.pbf', () => {
        expect(dayStyle().glyphs).toBe('/fonts/{fontstack}/{range}.pbf');
        expect(nightStyle().glyphs).toBe('/fonts/{fontstack}/{range}.pbf');
    });

    it('layers appear in the expected order with the expected ids', () => {
        for (const s of [dayStyle(), nightStyle()]) {
            const ids = s.layers.map((l: LayerSpecification) => l.id);
            expect(ids).toEqual(EXPECTED_LAYER_IDS);
        }
    });

    it('state-boundary minzoom=3 and city-label minzoom=4', () => {
        for (const s of [dayStyle(), nightStyle()]) {
            const stateBoundary = s.layers.find((l: LayerSpecification) => l.id === 'state-boundary');
            const cityLabel = s.layers.find((l: LayerSpecification) => l.id === 'city-label');
            expect(stateBoundary?.minzoom).toBe(3);
            expect(cityLabel?.minzoom).toBe(4);
        }
    });

    it('city-label has a rank_max filter of the shape [">=", ["get", "rank_max"], <expr>]', () => {
        // NE rank_max is higher = more important (NYC=14, Elko=5), so the
        // filter must keep cities with rank_max >= threshold.
        for (const s of [dayStyle(), nightStyle()]) {
            const cityLabel = s.layers.find((l: LayerSpecification) => l.id === 'city-label');
            const filter = (cityLabel as { filter?: unknown[] } | undefined)?.filter;
            expect(Array.isArray(filter)).toBe(true);
            expect(filter![0]).toBe('>=');
            expect(filter![1]).toEqual(['get', 'rank_max']);
        }
    });

    it('no layer has a source-layer field (those are tile-source-only)', () => {
        for (const s of [dayStyle(), nightStyle()]) {
            for (const layer of s.layers) {
                expect((layer as { 'source-layer'?: unknown })['source-layer']).toBeUndefined();
            }
        }
    });

    it('day and night layer shape (id+type, in order) is identical — required by setStyle({ diff: true })', () => {
        const shape = (s: StyleSpecification) => s.layers.map((l) => ({ id: l.id, type: l.type }));
        expect(shape(dayStyle())).toEqual(shape(nightStyle()));
    });
});
