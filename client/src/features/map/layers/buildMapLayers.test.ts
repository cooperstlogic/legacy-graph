import { describe, it, expect } from 'vitest';
import {
    buildMapLayers,
    prepareEvents,
    getTimeFilterValue,
    timeFilterRange,
    YEAR_SENTINEL,
    type PreparedEvent,
} from './buildMapLayers';
import type { MapEvent } from '../types';

function makeEvent(overrides: Partial<MapEvent> = {}): MapEvent {
    return {
        id: overrides.id ?? 'e1',
        person_id: overrides.person_id ?? 'p1',
        person_name: overrides.person_name ?? 'Test Person',
        type: overrides.type ?? 'birth',
        lat: overrides.lat ?? 40,
        lng: overrides.lng ?? -74,
        sort_date: overrides.sort_date ?? '1900-01-01',
        sort_end_date: overrides.sort_end_date ?? null,
        has_assets: overrides.has_assets ?? false,
        place_name: overrides.place_name ?? 'New York',
    };
}

function makePrepared(overrides: Partial<MapEvent> = {}): PreparedEvent {
    return prepareEvents([makeEvent(overrides)])[0];
}

const baseArgs = {
    events: [makePrepared({ id: 'a' }), makePrepared({ id: 'b', type: 'death' })],
    filterRange: timeFilterRange(1800, 2000),
    personEvents: null,
    scope: 'all' as const,
    focalPersonId: null,
    theme: 'light' as const,
};

describe('GPU time filter', () => {
    it('attaches the 2-component window filter range to heatmap and pins', () => {
        const layers = buildMapLayers({ ...baseArgs, zoom: 4, filterRange: timeFilterRange(1900, 1950) });
        for (const id of ['events-heatmap', 'events-pins']) {
            const layer = layers.find((l) => l.id === id);
            const props = layer?.props as { filterRange?: number[][]; extensions?: unknown[] };
            expect(props.filterRange).toEqual([
                [1900, YEAR_SENTINEL],
                [-YEAR_SENTINEL, 1950],
            ]);
            expect(props.extensions?.length).toBe(1);
        }
    });

    it('encodes dated events as [endYear, startYear] filter values', () => {
        const dated = makePrepared({ sort_date: '1900-05-01', sort_end_date: '1910-01-01' });
        expect(getTimeFilterValue(dated)).toEqual([1910, 1900]);
        const point = makePrepared({ sort_date: '1950-04-01' });
        expect(getTimeFilterValue(point)).toEqual([1950, 1950]);
    });

    it('gives undated events sentinel values that pass any window', () => {
        const [undated] = prepareEvents([{ ...makeEvent(), sort_date: null, sort_end_date: null }]);
        expect(getTimeFilterValue(undated)).toEqual([YEAR_SENTINEL, -YEAR_SENTINEL]);
    });
});

describe('prepareEvents', () => {
    it('parses start and end years once per event', () => {
        const [e] = prepareEvents([makeEvent({ sort_date: '1900-05-01', sort_end_date: '1910-02-03' })]);
        expect(e.startYear).toBe(1900);
        expect(e.endYear).toBe(1910);
    });

    it('falls back endYear to startYear for point-in-time events', () => {
        const [e] = prepareEvents([makeEvent({ sort_date: '1950-04-01', sort_end_date: null })]);
        expect(e.startYear).toBe(1950);
        expect(e.endYear).toBe(1950);
    });

    it('leaves both years null for undated events', () => {
        const [e] = prepareEvents([{ ...makeEvent(), sort_date: null, sort_end_date: null }]);
        expect(e.startYear).toBeNull();
        expect(e.endYear).toBeNull();
    });
});

describe('buildMapLayers', () => {
    it('always emits events-embers, events-heatmap and events-pins layers', () => {
        for (const zoom of [0, 2, 4, 6, 8]) {
            const layers = buildMapLayers({ ...baseArgs, zoom });
            const ids = layers.map((l) => l.id);
            expect(ids).toContain('events-embers');
            expect(ids).toContain('events-heatmap');
            expect(ids).toContain('events-pins');
        }
    });

    it('draws embers under the heatmap, visible in the heatmap band and gone at high zoom', () => {
        const low = buildMapLayers({ ...baseArgs, zoom: 1 });
        const ids = low.map((l) => l.id);
        expect(ids.indexOf('events-embers')).toBeLessThan(ids.indexOf('events-heatmap'));
        expect(low.find((l) => l.id === 'events-embers')?.props.visible).toBe(true);

        const high = buildMapLayers({ ...baseArgs, zoom: 7 });
        expect(high.find((l) => l.id === 'events-embers')?.props.visible).toBe(false);
    });

    it('embers share the stable data array, the GPU time filter, and are not pickable', () => {
        const layers = buildMapLayers({ ...baseArgs, zoom: 2, filterRange: timeFilterRange(1900, 1950) });
        const embers = layers.find((l) => l.id === 'events-embers');
        const props = embers?.props as {
            data?: unknown;
            pickable?: boolean;
            filterRange?: number[][];
            extensions?: unknown[];
        };
        expect(props.data).toBe(baseArgs.events);
        expect(props.pickable).toBe(false);
        expect(props.filterRange).toEqual([
            [1900, YEAR_SENTINEL],
            [-YEAR_SENTINEL, 1950],
        ]);
        expect(props.extensions?.length).toBe(1);
    });

    it('keeps the heatmap threshold low so faint areas are not culled (dynamic range)', () => {
        const layers = buildMapLayers({ ...baseArgs, zoom: 2 });
        const heat = layers.find((l) => l.id === 'events-heatmap');
        expect((heat?.props as { threshold?: number }).threshold).toBe(0.01);
    });

    it('hides the heatmap at high zoom and shows pins; reverses at low zoom', () => {
        const low = buildMapLayers({ ...baseArgs, zoom: 1 });
        const lowHeat = low.find((l) => l.id === 'events-heatmap');
        const lowPins = low.find((l) => l.id === 'events-pins');
        expect(lowHeat?.props.visible).toBe(true);
        expect(lowPins?.props.visible).toBe(false);

        const high = buildMapLayers({ ...baseArgs, zoom: 7 });
        const highHeat = high.find((l) => l.id === 'events-heatmap');
        const highPins = high.find((l) => l.id === 'events-pins');
        expect(highHeat?.props.visible).toBe(false);
        expect(highPins?.props.visible).toBe(true);
    });

    it('crossfades between zoom 3 and 5 — both layers visible in the middle', () => {
        const mid = buildMapLayers({ ...baseArgs, zoom: 4 });
        const heat = mid.find((l) => l.id === 'events-heatmap');
        const pins = mid.find((l) => l.id === 'events-pins');
        expect(heat?.props.visible).toBe(true);
        expect(pins?.props.visible).toBe(true);
    });

    it('keeps heatmap radiusPixels constant (Phase B baseline)', () => {
        // Heatmap radius is fixed at 40 — changing it on zoom forces the
        // weight texture to regenerate, causing visible choppiness.
        const a = buildMapLayers({ ...baseArgs, zoom: 1 });
        const b = buildMapLayers({ ...baseArgs, zoom: 4 });
        const ra = (a.find((l) => l.id === 'events-heatmap')?.props as { radiusPixels?: number }).radiusPixels;
        const rb = (b.find((l) => l.id === 'events-heatmap')?.props as { radiusPixels?: number }).radiusPixels;
        expect(ra).toBe(40);
        expect(rb).toBe(40);
    });

    it('emits no focal-path layers when scope is not focal', () => {
        const layers = buildMapLayers({ ...baseArgs, zoom: 5 });
        const ids = layers.map((l) => l.id);
        expect(ids).not.toContain('focal-path');
        expect(ids).not.toContain('focal-path-halo');
    });

    it('emits no focal-path layers when personEvents has fewer than 2 stops', () => {
        const personEvents = [makePrepared({ id: 'p1-e1' })];
        const layers = buildMapLayers({
            ...baseArgs,
            zoom: 5,
            scope: 'focal',
            focalPersonId: 'p1',
            personEvents,
        });
        const ids = layers.map((l) => l.id);
        expect(ids).not.toContain('focal-path');
        expect(ids).not.toContain('focal-path-halo');
    });

    it('emits a halo + stroke pair (in that order, behind the pins) when focal scope has ≥2 stops', () => {
        const personEvents = [
            makePrepared({ id: 'p1-e1', sort_date: '1900-01-01' }),
            makePrepared({ id: 'p1-e2', sort_date: '1920-01-01', lng: -75 }),
            makePrepared({ id: 'p1-e3', sort_date: '1980-01-01', lng: -76 }),
        ];
        const layers = buildMapLayers({
            ...baseArgs,
            zoom: 5,
            scope: 'focal',
            focalPersonId: 'p1',
            personEvents,
        });
        const ids = layers.map((l) => l.id);
        const haloIdx = ids.indexOf('focal-path-halo');
        const strokeIdx = ids.indexOf('focal-path');
        const pinsIdx = ids.indexOf('events-pins');
        expect(haloIdx).toBeGreaterThanOrEqual(0);
        expect(strokeIdx).toBeGreaterThan(haloIdx);
        expect(pinsIdx).toBeGreaterThan(strokeIdx);
    });

    it('halo is wider than the stroke (5 px vs 3 px)', () => {
        const personEvents = [makePrepared({ id: 'a' }), makePrepared({ id: 'b', lng: -75 })];
        const layers = buildMapLayers({
            ...baseArgs,
            zoom: 5,
            scope: 'focal',
            focalPersonId: 'p1',
            personEvents,
        });
        const halo = layers.find((l) => l.id === 'focal-path-halo');
        const stroke = layers.find((l) => l.id === 'focal-path');
        expect((halo?.props as { getWidth?: number }).getWidth).toBe(5);
        expect((stroke?.props as { getWidth?: number }).getWidth).toBe(3);
    });

    it('keeps layer ids stable across calls (so deck.gl can match instances)', () => {
        const a = buildMapLayers({ ...baseArgs, zoom: 4 }).map((l) => l.id);
        const b = buildMapLayers({ ...baseArgs, zoom: 4 }).map((l) => l.id);
        expect(a).toEqual(b);
    });

    it('reuses one _subLayerProps object across builds (identity marks aggregation dirty)', () => {
        // _subLayerProps is NOT in HeatmapLayer's ignoreProps set, so a fresh
        // object literal per build makes isAggregationDirty report
        // "props._subLayerProps changed shallowly" → immediate re-aggregation,
        // i.e. the ~200 ms max-weight pass on every zoom step. Must be a
        // module-scope constant.
        const a = buildMapLayers({ ...baseArgs, zoom: 2 });
        const b = buildMapLayers({ ...baseArgs, zoom: 4 });
        const slpA = (a.find((l) => l.id === 'events-heatmap')?.props as { _subLayerProps?: object })
            ._subLayerProps;
        const slpB = (b.find((l) => l.id === 'events-heatmap')?.props as { _subLayerProps?: object })
            ._subLayerProps;
        expect(slpA).toBeDefined();
        expect(slpA).toBe(slpB);
    });

    it('caps the heatmap weights texture at 1024 (max-weight pass is textureSize²)', () => {
        // HeatmapLayer reduces the weights texture to a 1×1 max by drawing
        // textureSize² point vertices that all blend into a single texel. At
        // the 2048 default that is 4.19M vertices ≈ 200 ms of GPU time per
        // aggregation; 1024 brings it to ~50 ms.
        const layers = buildMapLayers({ ...baseArgs, zoom: 2 });
        const heat = layers.find((l) => l.id === 'events-heatmap');
        expect((heat?.props as { weightsTextureSize?: number }).weightsTextureSize).toBe(1024);
    });
});
