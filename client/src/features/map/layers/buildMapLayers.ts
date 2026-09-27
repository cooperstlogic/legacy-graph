import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { DataFilterExtension, type DataFilterExtensionProps } from '@deck.gl/extensions';
import { FilteredHeatmapLayer } from './FilteredHeatmapLayer';
import type { Layer } from '@deck.gl/core';
import type { MapEvent, MapScope } from '../types';
import { TYPE_COLORS, TYPE_WEIGHTS, type EventType } from '../eventTypes';
import { parseEventYear } from '../timeStore';

// Event enriched with pre-parsed years. Computed once per data refresh in
// MapView (prepareEvents) so the per-frame window filter is pure number math
// and the deck.gl accessors stay pure & stable.
export type PreparedEvent = MapEvent & {
    /** Year of sort_date; null = undated. */
    startYear: number | null;
    /** Year of sort_end_date, falling back to startYear for point events. */
    endYear: number | null;
};

/** Enrich raw API events with pre-parsed years. Called once per data load. */
export function prepareEvents(events: MapEvent[]): PreparedEvent[] {
    return events.map((e) => {
        const startYear = parseEventYear(e.sort_date);
        const endYear = e.sort_end_date ? (parseEventYear(e.sort_end_date) ?? startYear) : startYear;
        return { ...e, startYear, endYear };
    });
}

export interface BuildLayersArgs {
    /** Type/undated-filtered events. NOT window-filtered — time visibility is a
     *  GPU filter (see getTimeFilterValue), so this array reference is stable
     *  across window scrubs, playback ticks, and zoom changes, and deck.gl
     *  never re-uploads attributes or re-parses data for them. */
    events: PreparedEvent[];
    /** GPU window filter range from timeFilterRange(windowStart, windowEnd). */
    filterRange: [[number, number], [number, number]];
    /** Pre-filtered + sorted focal-scope events. null when scope !== 'focal'. */
    personEvents: PreparedEvent[] | null;
    zoom: number;
    scope: MapScope;
    focalPersonId: string | null;
    theme: 'dark' | 'light';
}

/** Id of the pickable pin layer; clicks are handled on the overlay, keyed on this. */
export const PIN_LAYER_ID = 'events-pins';

// ---- GPU time filter ------------------------------------------------------
// The time window is applied on the GPU via DataFilterExtension so that
// scrubbing/playback only changes a uniform (filterRange) — no CPU filter
// pass, no attribute re-upload. Encoding: each event carries a 2-component
// filter value [endYear, startYear]; the window becomes the per-component
// range [[windowStart, +B], [-B, windowEnd]]. An event passes both checks
// iff endYear >= windowStart && startYear <= windowEnd — i.e. the event's
// year interval overlaps the window (point events have startYear === endYear).

/** Sentinel beyond any real year (float32-exact). Undated events use ±B so
 *  they pass every window; their visibility is decided CPU-side by the
 *  showUndated toggle (a rare change, allowed to rebuild the data array). */
export const YEAR_SENTINEL = 1_000_000;

export function getTimeFilterValue(e: PreparedEvent): [number, number] {
    if (e.startYear === null) return [YEAR_SENTINEL, -YEAR_SENTINEL];
    return [e.endYear ?? e.startYear, e.startYear];
}

export function timeFilterRange(
    windowStart: number,
    windowEnd: number,
): [[number, number], [number, number]] {
    return [
        [windowStart, YEAR_SENTINEL],
        [-YEAR_SENTINEL, windowEnd],
    ];
}

// Single shared extension instance — a stable reference keeps deck.gl's
// extensionsChanged flag false across layer rebuilds.
const TIME_FILTER_EXTENSION = new DataFilterExtension({ filterSize: 2 });

// Module-scope accessors: stable references across renders so deck.gl can
// skip re-tessellating GPU buffers when only zoom/opacity change.
const getRawPosition = (e: MapEvent): [number, number] => [e.lng, e.lat];
const getFillColor = (e: MapEvent): [number, number, number, number] =>
    TYPE_COLORS[e.type as EventType] ?? [200, 200, 200, 220];
const getRadius = (): number => 6;
const getEmberRadius = (): number => 1.5;
const getWeight = (e: MapEvent): number => TYPE_WEIGHTS[e.type as EventType] ?? 0.5;
const getPath = (d: { path: [number, number][] }) => d.path;

// CompositeLayer forwards `extensions` to sublayers. The heatmap's internal
// TriangleLayer (the screen-space quad that paints the colorized weight
// texture) has no per-event attributes, so the filter varying defaults to 0
// there and the extension discards every fragment — a blank heatmap. Filtering
// must only apply to the weight-aggregation pass, so strip extensions from the
// triangle.
//
// Module scope is load-bearing: `_subLayerProps` is NOT in HeatmapLayer's
// `ignoreProps` set, so a fresh object literal per build makes
// `isAggregationDirty({ compareAll: true })` report "props._subLayerProps
// changed shallowly". That sets `dataChanged`, which clears the 500 ms
// debounce and re-runs the weight aggregation *immediately* — including the
// max-weight reduction pass (see HEATMAP_WEIGHTS_TEXTURE_SIZE). Measured on an
// M2: one ~200 ms GPU stall per 0.5-zoom-step layer rebuild below zoom 5,
// where `layerZoom` still varies. A stable reference makes the whole rebuild
// aggregation-clean.
const HEATMAP_SUBLAYER_PROPS = { 'triangle-layer': { extensions: [] } };

// HeatmapLayer reduces its weights texture to a 1×1 max by drawing
// `weightsTextureSize²` point vertices that all blend-max into a single texel —
// every fragment contends for one pixel, so the raster ops serialize. At the
// 2048 default that is 4,194,304 vertices ≈ 200 ms of GPU time per
// aggregation (no JS long task — the main thread is idle while frames drop).
// 1024 quarters the vertex count to ~50 ms.
//
// Do not raise this. Lowering it further buys little: 512 and 256 measured the
// same ~50 ms, and a smaller texture also shrinks the cached world-bounds
// margin (`textureSize * 2 / viewport.scale`), so zoom-out escapes its bounds
// and re-aggregates more often.
const HEATMAP_WEIGHTS_TEXTURE_SIZE = 1024;

// Ember dot color per theme — warm amber, matching the heatmap's ramp so the
// dots read as the faint end of the same scale, not a separate encoding.
const EMBER_COLOR_DARK: [number, number, number, number] = [255, 200, 130, 150];
const EMBER_COLOR_LIGHT: [number, number, number, number] = [180, 95, 30, 150];

/** Produce the deck.gl layer array for a given (zoom, data) combo.
 *  Layer order (back-to-front): embers → heatmap → focal-path-halo →
 *  focal-path → pins. All event layers are emitted at every zoom —
 *  `visible: false` skips rendering when opacity would be ~0 but keeps the
 *  layer instance and its GPU resources alive. This avoids the layer
 *  add/remove churn that previously tore down the HeatmapLayer framebuffer
 *  at the zoom-3 / zoom-5 thresholds. */
export function buildMapLayers(args: BuildLayersArgs): Layer[] {
    const { events, filterRange, personEvents, zoom, theme } = args;

    const heatmapOpacity = zoom < 3 ? 1 : zoom < 5 ? (5 - zoom) / 2 : 0;
    const pinOpacity = zoom >= 5 ? 1 : zoom > 3 ? (zoom - 3) / 2 : 0;

    const layers: Layer[] = [];

    // Ember under-layer: a tiny dot per event, always on in the heatmap band.
    // The heatmap normalizes its color scale to the densest cluster in view,
    // so isolated events land below its threshold and would otherwise vanish
    // entirely at low zoom — this layer is the visibility floor that keeps the
    // sparse end of the dynamic range on the map. Not pickable: interaction
    // belongs to the pins at high zoom.
    layers.push(new ScatterplotLayer<PreparedEvent, DataFilterExtensionProps<PreparedEvent>>({
        id: 'events-embers',
        data: events,
        visible: heatmapOpacity > 0.02,
        pickable: false,
        radiusUnits: 'pixels',
        getRadius: getEmberRadius,
        getFillColor: theme === 'dark' ? EMBER_COLOR_DARK : EMBER_COLOR_LIGHT,
        getPosition: getRawPosition,
        extensions: [TIME_FILTER_EXTENSION],
        getFilterValue: getTimeFilterValue,
        filterRange,
        opacity: heatmapOpacity,
    }));

    layers.push(new FilteredHeatmapLayer<PreparedEvent, DataFilterExtensionProps<PreparedEvent>>({
        id: 'events-heatmap',
        data: events,
        visible: heatmapOpacity > 0.02,
        getPosition: getRawPosition,
        getWeight,
        extensions: [TIME_FILTER_EXTENSION],
        getFilterValue: getTimeFilterValue,
        filterRange,

        // Both of these must stay identity-stable / constant across builds —
        // see the constants' comments. A fresh `_subLayerProps` literal or a
        // larger weights texture reintroduces a ~200 ms GPU stall per zoom step.
        _subLayerProps: HEATMAP_SUBLAYER_PROPS,
        weightsTextureSize: HEATMAP_WEIGHTS_TEXTURE_SIZE,
        // Constant radiusPixels by design (spec §6.11): changing this prop
        // forces HeatmapLayer to regenerate its weight texture on every zoom
        // frame, causing visible choppiness. A fixed radius keeps the glow
        // stable across the crossfade. Do not move this into updateTriggers.
        radiusPixels: 40,
        intensity: 1.2,
        // Low threshold so faint areas are not culled outright — the heatmap
        // normalizes to the densest cluster in view, and with the default 0.03
        // a 20-event town next to a 500-event city fell below the cutoff.
        threshold: 0.01,
        opacity: heatmapOpacity,
        // Warm-amber gradient, gamma-compressed: most of the luminance ramp is
        // spent on the low end so minor clusters read clearly against a
        // hotspot-normalized max, while the top stops still saturate. Together
        // with the ember floor this is the dynamic-range strategy — do not
        // re-linearize without checking a sparse+dense fixture side by side.
        colorRange: [
            [8, 16, 40, 0],
            [120, 70, 90, 190],
            [210, 130, 70, 220],
            [245, 185, 90, 235],
            [255, 225, 150, 245],
            [255, 250, 220, 255],
        ],
    }));

    // Connected-path view: only when scope is "focal" (a single person) and the
    // pre-filtered personEvents arg has at least 2 stops. Birth → residences (by
    // sort_date) → death, drawn as a glowing polyline.
    //
    // Two stacked PathLayers — a 5 px halo behind a 3 px stroke — give the line
    // a glow/contrast against either basemap theme without requiring a shader.
    if (personEvents && personEvents.length >= 2) {
        const path = personEvents.map((e) => [e.lng, e.lat] as [number, number]);
        const data = [{ path }];
        const haloColor: [number, number, number, number] =
            theme === 'dark' ? [0, 0, 0, 140] : [255, 255, 255, 180];
        const strokeColor: [number, number, number, number] =
            theme === 'dark' ? [236, 170, 70, 230] : [180, 95, 30, 230];
        layers.push(new PathLayer({
            id: 'focal-path-halo',
            data,
            getPath,
            getColor: haloColor,
            getWidth: 5,
            widthUnits: 'pixels',
            jointRounded: true,
            capRounded: true,
        }));
        layers.push(new PathLayer({
            id: 'focal-path',
            data,
            getPath,
            getColor: strokeColor,
            getWidth: 3,
            widthUnits: 'pixels',
            jointRounded: true,
            capRounded: true,
        }));
    }

    layers.push(new ScatterplotLayer<PreparedEvent, DataFilterExtensionProps<PreparedEvent>>({
        id: PIN_LAYER_ID,
        data: events,
        visible: pinOpacity > 0.02,
        pickable: true,
        radiusUnits: 'pixels',
        getRadius,
        getFillColor,
        getPosition: getRawPosition,
        extensions: [TIME_FILTER_EXTENSION],
        getFilterValue: getTimeFilterValue,
        filterRange,
        opacity: pinOpacity,
    }));

    return layers;
}
