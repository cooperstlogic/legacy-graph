import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibreMap, setWorkerUrl, type IControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// maplibre-gl 6 locates its worker via import.meta.url, which doesn't survive
// bundling; `?worker&url` has Vite emit a self-contained worker chunk instead.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { Link, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useUIStore } from '@/shared/store/uiStore';
import { useFocalStore } from '@/shared/store/focalStore';
import { useMapEvents } from './api';
import { dayStyle } from './styles/day';
import { nightStyle } from './styles/night';
import { useMapPrefsStore } from './prefsStore';
import { buildMapLayers, prepareEvents, timeFilterRange, type PreparedEvent } from './layers/buildMapLayers';
import { BASEMAP_MAX_ZOOM } from './constants';
import { useTimeStore, initWindowForExtent, seedWindowFromUrl, computeYearHistogram } from './timeStore';
import { TimeSlider } from './TimeSlider';
import { MapToolbar } from './MapToolbar';
import { EventDrawer } from './EventDrawer';
import { TopBarActions } from '@/shared/components/layout/TopBarSlotContext';
import type { MapEvent, MapSearch } from './types';
import type { EventType } from './eventTypes';

setWorkerUrl(maplibreWorkerUrl);

export function MapView() {
    const theme = useUIStore((s) => s.theme);
    const focalPersonId = useFocalStore((s) => s.focalPersonId);
    const setFocal = useFocalStore((s) => s.setFocal);
    const scope = useMapPrefsStore((s) => s.scope);
    const eventTypes = useMapPrefsStore((s) => s.eventTypes);
    const setScope = useMapPrefsStore((s) => s.setScope);
    const setGranularity = useMapPrefsStore((s) => s.setGranularity);
    const setSpeed = useMapPrefsStore((s) => s.setSpeed);
    const setLoop = useMapPrefsStore((s) => s.setLoop);
    const setPlaying = useTimeStore((s) => s.setPlaying);
    const navigate = useNavigate({ from: '/map' });
    const router = useRouter();
    // Subscribe only to ?event= — the sole search param we react to after boot.
    // Subscribing to the whole search object would re-render MapView on every
    // debounced URL write-back (i.e. every playback tick).
    const eventParam = useSearch({ from: '/map', select: (s) => s.event });

    // On mount: apply URL params to stores. Runs once — further URL changes
    // come from us, so the boot values are read imperatively off router state
    // instead of a reactive useSearch subscription.
    const didBootFromUrl = useRef(false);
    useEffect(() => {
        if (didBootFromUrl.current) return;
        didBootFromUrl.current = true;
        const search = router.state.location.search as MapSearch;
        if (search.scope) setScope(search.scope);
        if (search.person) setFocal(search.person);
        if (search.g) setGranularity(search.g);
        if (search.speed !== undefined) setSpeed(search.speed);
        if (search.loop !== undefined) setLoop(search.loop === 1);
        // seedWindowFromUrl (not setWindow) — marks the window as seeded so the
        // extent init after the first data load can't clobber the deep link.
        if (search.t !== undefined && search.t_end !== undefined) seedWindowFromUrl(search.t, search.t_end);
        if (search.play === 1) setPlaying(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Focal-dependent scopes are meaningless without a focal person. If the
    // focal is cleared (here or on the Graph page) while focal/lineage is
    // selected, fall back to 'all' so the map keeps showing something.
    useEffect(() => {
        if (!focalPersonId && (scope === 'focal' || scope === 'lineage')) {
            setScope('all');
        }
    }, [focalPersonId, scope, setScope]);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const mapRef = useRef<MapLibreMap | null>(null);
    const overlayRef = useRef<MapboxOverlay | null>(null);
    const [zoom, setZoom] = useState(2);
    // Drawer state: the co-located event list under the last click, and the
    // event whose card is currently shown (null + multi-list = list mode).
    const [drawerEvents, setDrawerEvents] = useState<MapEvent[] | null>(null);
    const [drawerActive, setDrawerActive] = useState<MapEvent | null>(null);

    const events = useMapEvents({ scope, focalPersonId });

    // Initialize MapLibre + deck.gl overlay on mount.
    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;
        const style = theme === 'dark' ? nightStyle() : dayStyle();
        const map = new MapLibreMap({
            container: containerRef.current,
            style,
            center: [0, 30],
            zoom: 2,
            minZoom: 0,
            maxZoom: BASEMAP_MAX_ZOOM,
            attributionControl: { compact: true },
        });
        // Throttle zoom updates: the crossfade only has meaningful thresholds at
        // zoom 3 and 5, so 0.5-step quantization (≈11 distinct values across the
        // 0–8 basemap range) is plenty. Tighter buckets force a fresh layer
        // rebuild for every fractional notch a wheel/pinch crosses, and each
        // rebuild constructs new Heatmap/Scatter Layer instances.
        const onZoom = () => {
            const z = Math.round(map.getZoom() * 2) / 2;
            setZoom((prev) => (prev === z ? prev : z));
        };
        map.on('zoom', onZoom);
        map.on('zoomend', onZoom);
        const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
        map.addControl(overlay as unknown as IControl);
        mapRef.current = map;
        overlayRef.current = overlay;
        // Visual-regression test harness hook (tests/e2e/map-snapshots.spec.ts).
        // Exposed unconditionally — harmless in production, avoids env-dependent
        // diverging behaviour between dev and CI snapshot runs.
        (window as unknown as { __map?: MapLibreMap }).__map = map;

        return () => {
            (window as unknown as { __map?: MapLibreMap }).__map = undefined;
            map.remove();
            mapRef.current = null;
            overlayRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Swap style when theme toggles.
    useEffect(() => {
        if (!mapRef.current) return;
        const style = theme === 'dark' ? nightStyle() : dayStyle();
        mapRef.current.setStyle(style, { diff: true });
    }, [theme]);

    // Seed time window from event extent on first successful load.
    useEffect(() => {
        if (events.data) initWindowForExtent(events.data.extent.minDate, events.data.extent.maxDate);
    }, [events.data]);

    // Fly to the extent of the current filtered data whenever the bbox actually changes.
    const lastFlownToKey = useRef<string | null>(null);
    useEffect(() => {
        if (!mapRef.current || !events.data) return;
        const key = `${scope}:${focalPersonId ?? '_'}:${events.data.events.length}`;
        if (lastFlownToKey.current === key) return;
        const bbox = events.data.extent.bbox;
        if (!bbox) return;
        const [w, s, e, n] = bbox;
        mapRef.current.fitBounds([[w, s], [e, n]], { padding: 60, duration: 400, maxZoom: BASEMAP_MAX_ZOOM });
        lastFlownToKey.current = key;
    }, [scope, focalPersonId, events.data]);

    // Rebuild deck.gl layers whenever events / zoom / scope change. Time-window
    // changes do NOT rebuild data — they only swap the GPU filterRange uniform.
    const windowStart = useTimeStore((s) => s.windowStart);
    const windowEnd = useTimeStore((s) => s.windowEnd);
    const showUndated = useTimeStore((s) => s.showUndated);

    // Pre-parse event years once per data change. Keyed on events.data — not
    // dataUpdatedAt — so React Query's structural sharing keeps this (and every
    // downstream memo, GPU buffer, and heatmap texture) stable across refetches
    // that return identical data (window refocus, staleTime expiry).
    const preparedEvents = useMemo<PreparedEvent[]>(
        () => prepareEvents(events.data?.events ?? []),
        [events.data],
    );

    // Pre-filter focal-scope events once per data/scope/focal change.
    const personEvents = useMemo<PreparedEvent[] | null>(() => {
        if (scope !== 'focal' || !focalPersonId) return null;
        return preparedEvents
            .filter((e) => e.person_id === focalPersonId && e.sort_date)
            .sort((a, b) => (a.sort_date ?? '').localeCompare(b.sort_date ?? ''));
    }, [preparedEvents, scope, focalPersonId]);

    // Lift the type-filter set into a stable Set so filtering is O(1) per event
    // and we don't reallocate on every render.
    const typeFilter = useMemo<Set<EventType> | null>(() => {
        if (eventTypes === null) return null;
        return new Set(eventTypes);
    }, [eventTypes]);

    // Event-type + undated filter — the only CPU-side filtering, and both
    // change rarely (checkbox clicks). The time window is deliberately NOT
    // part of this memo: window visibility runs on the GPU via filterRange,
    // so scrubbing and playback never rebuild this array.
    const eventsForLayers = useMemo<PreparedEvent[]>(() => {
        return preparedEvents.filter((e) => {
            if (typeFilter && !typeFilter.has(e.type as EventType)) return false;
            if (e.startYear === null && !showUndated) return false;
            return true;
        });
    }, [preparedEvents, showUndated, typeFilter]);

    // GPU window filter uniform — the per-scrub-frame update is just this pair.
    const filterRange = useMemo(
        () => timeFilterRange(windowStart, windowEnd),
        [windowStart, windowEnd],
    );

    // Event-count strip behind the slider track. Reflects the type/undated
    // filter (same event set the layers draw from), not the time window.
    const extentStart = useTimeStore((s) => s.extentStart);
    const extentEnd = useTimeStore((s) => s.extentEnd);
    const histogram = useMemo(
        () => computeYearHistogram(eventsForLayers, extentStart, extentEnd, 80),
        [eventsForLayers, extentStart, extentEnd],
    );

    // Above zoom 5 every layer-affecting value (heatmap visibility, pin
    // visibility/opacity) is constant, so collapse to a single value there.
    // This is what keeps the layers useMemo result stable while the user
    // pans/zooms in the high-zoom range — no setProps, no deck.gl diff work.
    const layerZoom = useMemo(() => Math.min(zoom, 5), [zoom]);

    // Defer `onPinClick` declaration: declared below as a useCallback. We
    // build layers off a stable click ref so the layer rebuild deps stay tight.
    const clickRef = useRef<(info: PickingInfo<PreparedEvent>) => void>(() => {});

    const layers = useMemo<Layer[]>(() => {
        return buildMapLayers({
            events: eventsForLayers,
            filterRange,
            personEvents,
            zoom: layerZoom,
            scope,
            focalPersonId,
            theme,
            onPinClick: (info) => clickRef.current(info),
        });
    }, [eventsForLayers, filterRange, personEvents, layerZoom, scope, focalPersonId, theme]);

    useEffect(() => {
        overlayRef.current?.setProps({ layers });
    }, [layers]);

    // Open drawer once when ?event=<id> is in the URL on first data load.
    // Keyed on the URL value so we don't re-open after the user closes.
    const lastOpenedEventId = useRef<string | null>(null);
    useEffect(() => {
        if (!events.data) return;
        const id = eventParam;
        if (!id || lastOpenedEventId.current === id) return;
        const target = events.data.events.find((e) => e.id === id);
        if (!target) return;
        lastOpenedEventId.current = id;
        setDrawerEvents([target]);
        setDrawerActive(target);
    }, [events.data, eventParam]);

    // Drawer open/close also writes ?event= synchronously to avoid a race where
    // the debounced URL writer below re-emits the stale value after close.
    const onCloseDrawer = useCallback(() => {
        setDrawerEvents(null);
        setDrawerActive(null);
        lastOpenedEventId.current = null;
        navigate({
            to: '/map',
            search: (prev) => ({ ...prev, event: undefined }),
            replace: true,
        });
    }, [navigate]);

    // Show one event's card (from a direct pick or a list selection) and deep-link it.
    const onSelectEvent = useCallback((evt: MapEvent) => {
        setDrawerActive(evt);
        lastOpenedEventId.current = evt.id;
        navigate({
            to: '/map',
            search: (prev) => ({ ...prev, event: evt.id }),
            replace: true,
        });
    }, [navigate]);

    // Card → back to the co-located list. Clears ?event= (the list itself has
    // no deep-link representation).
    const onBackToList = useCallback(() => {
        setDrawerActive(null);
        lastOpenedEventId.current = null;
        navigate({
            to: '/map',
            search: (prev) => ({ ...prev, event: undefined }),
            replace: true,
        });
    }, [navigate]);

    // Pin click: events geocoded to the same place stack at one point (the
    // zoom-8 basemap cap ≈ 600 m/px, so stacks never spread apart visually).
    // deck.gl's onClick surfaces only the topmost pin — pick everything within
    // a small radius and let the drawer disambiguate.
    const onPinClick = useCallback((info: PickingInfo<PreparedEvent>) => {
        const clicked = info.object as MapEvent | null;
        if (!clicked) return;
        let picked: MapEvent[] = [clicked];
        const overlay = overlayRef.current;
        if (overlay) {
            const picks = overlay.pickMultipleObjects({
                x: info.x,
                y: info.y,
                radius: 4,
                layerIds: ['events-pins'],
                depth: 24,
            });
            const seen = new Map<string, MapEvent>();
            for (const p of picks) {
                const obj = p.object as MapEvent | undefined;
                if (obj && !seen.has(obj.id)) seen.set(obj.id, obj);
            }
            if (seen.size > 0) picked = [...seen.values()];
        }
        setDrawerEvents(picked);
        if (picked.length === 1) {
            onSelectEvent(picked[0]);
        } else {
            setDrawerActive(null);
        }
    }, [onSelectEvent]);

    useEffect(() => {
        clickRef.current = onPinClick;
    }, [onPinClick]);

    // Write current state back to the URL (debounced). Keeps share/reload identical.
    const granularity = useMapPrefsStore((s) => s.granularity);
    const speed = useMapPrefsStore((s) => s.speed);
    const loop = useMapPrefsStore((s) => s.loop);
    const isPlaying = useTimeStore((s) => s.isPlaying);
    useEffect(() => {
        if (!didBootFromUrl.current) return;
        const t = setTimeout(() => {
            // Omit t/t_end when the window equals the full extent — keeps the
            // URL clean for users who haven't scrubbed.
            const atExtent =
                Math.round(windowStart) === Math.round(extentStart) &&
                Math.round(windowEnd) === Math.round(extentEnd);
            navigate({
                to: '/map',
                search: (prev) => ({
                    ...prev,
                    scope: scope === 'all' ? undefined : scope,
                    person: focalPersonId ?? undefined,
                    g: granularity === 'decade' ? undefined : granularity,
                    speed: speed === 1 ? undefined : speed,
                    loop: loop ? 1 : undefined,
                    play: isPlaying ? 1 : undefined,
                    t: atExtent ? undefined : Math.round(windowStart),
                    t_end: atExtent ? undefined : Math.round(windowEnd),
                }),
                replace: true,
            });
        }, 200);
        return () => clearTimeout(t);
    }, [scope, focalPersonId, granularity, speed, loop, isPlaying, windowStart, windowEnd, extentStart, extentEnd, navigate]);

    const isLoading = events.isLoading || (events.isFetching && !events.data);
    const hasNoEvents = !!events.data && events.data.events.length === 0;

    return (
        <div className="relative h-full w-full">
            <TopBarActions>
                <MapToolbar />
            </TopBarActions>
            <div ref={containerRef} className="h-full w-full" />
            <TimeSlider histogram={histogram} />
            {isLoading && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="rounded-md border border-border bg-card/80 backdrop-blur-sm px-4 py-2 text-sm text-muted-foreground shadow-sm">
                        Loading events…
                    </div>
                </div>
            )}
            {hasNoEvents && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="pointer-events-auto max-w-sm rounded-lg border border-border bg-card/95 shadow-lg p-5 text-sm text-center">
                        <p className="font-medium">No events with coordinates yet</p>
                        <p className="mt-1 text-muted-foreground">
                            Geocode the events in your tree to see them here.
                        </p>
                        <Link to="/settings" className="mt-3 inline-block text-primary hover:underline">
                            Go to Settings → Geocoding
                        </Link>
                    </div>
                </div>
            )}
            <EventDrawer
                events={drawerEvents}
                active={drawerActive}
                onSelect={onSelectEvent}
                onBack={onBackToList}
                onClose={onCloseDrawer}
            />
        </div>
    );
}
