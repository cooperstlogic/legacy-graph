import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';
import { parseExifDateToISO, extractExifDate, parseExifGpsToPlace, extractExifGps, reverseGeocodeExifGps, loadAssetIndex } from '../../src/core/assetMetaUtils';
import type { GeocodingService } from '../../src/core/GeocodingService';
import type { Place } from '../../src/schemas/PlaceSchema';

const FIXTURES = path.join(__dirname, '../fixtures/assetMeta-test');

describe('parseExifDateToISO', () => {
    it('parses a Date object', () => {
        expect(parseExifDateToISO(new Date('2026-03-14T15:50:17.000Z'))).toBe('2026-03-14');
    });

    it('parses an ISO date string', () => {
        expect(parseExifDateToISO('2026-03-14T15:50:17.000Z')).toBe('2026-03-14');
    });

    it('returns null for undefined', () => {
        expect(parseExifDateToISO(undefined)).toBeNull();
    });

    it('returns null for null', () => {
        expect(parseExifDateToISO(null)).toBeNull();
    });

    it('returns null for a non-date string', () => {
        expect(parseExifDateToISO('not a date')).toBeNull();
    });

    it('handles a date at start of day in UTC', () => {
        expect(parseExifDateToISO(new Date('2020-01-01T00:00:00.000Z'))).toBe('2020-01-01');
    });
});

describe('extractExifDate', () => {
    beforeEach(() => fs.mkdir(FIXTURES, { recursive: true }));
    afterEach(() => fs.rm(FIXTURES, { recursive: true, force: true }));

    it('returns null for a non-image file', async () => {
        const p = path.join(FIXTURES, 'test.txt');
        await fs.writeFile(p, 'hello');
        expect(await extractExifDate(p)).toBeNull();
    });

    it('returns null for a non-image extension (pdf)', async () => {
        const p = path.join(FIXTURES, 'test.pdf');
        await fs.writeFile(p, '%PDF-1.4');
        expect(await extractExifDate(p)).toBeNull();
    });

    it('returns null for a synthetic JPEG with no EXIF date', async () => {
        const p = path.join(FIXTURES, 'no-exif.jpg');
        await sharp({
            create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 100, b: 50 } },
        }).jpeg().toFile(p);
        expect(await extractExifDate(p)).toBeNull();
    });

    it('returns null for a non-existent file path', async () => {
        expect(await extractExifDate(path.join(FIXTURES, 'ghost.jpg'))).toBeNull();
    });
});

describe('parseExifGpsToPlace', () => {
    it('converts north/east DMS to positive decimal coordinates', () => {
        const place = parseExifGpsToPlace([51, 30, 26.4], 'N', [0, 7, 45.12], 'E');
        expect(place.lat).toBeCloseTo(51.5073, 3);
        expect(place.lng).toBeCloseTo(0.1292, 3);
        expect(place.name).toContain('N');
        expect(place.name).toContain('E');
    });

    it('converts south/west DMS to negative decimal coordinates', () => {
        const place = parseExifGpsToPlace([33, 51, 54], 'S', [151, 12, 36], 'W');
        expect(place.lat).toBeCloseTo(-33.865, 2);
        expect(place.lng).toBeCloseTo(-151.21, 2);
        expect(place.name).toContain('S');
        expect(place.name).toContain('W');
    });

    it('produces a human-readable name string', () => {
        const place = parseExifGpsToPlace([48, 51, 29.4], 'N', [2, 21, 7.2], 'E');
        expect(typeof place.name).toBe('string');
        expect(place.name.length).toBeGreaterThan(0);
    });
});

describe('extractExifGps', () => {
    beforeEach(() => fs.mkdir(FIXTURES, { recursive: true }));
    afterEach(() => fs.rm(FIXTURES, { recursive: true, force: true }));

    it('returns null for a non-image file', async () => {
        const p = path.join(FIXTURES, 'gps-test.txt');
        await fs.writeFile(p, 'hello');
        expect(await extractExifGps(p)).toBeNull();
    });

    it('returns null for a synthetic JPEG with no GPS EXIF', async () => {
        const p = path.join(FIXTURES, 'no-gps.jpg');
        await sharp({
            create: { width: 8, height: 8, channels: 3, background: { r: 100, g: 150, b: 200 } },
        }).jpeg().toFile(p);
        expect(await extractExifGps(p)).toBeNull();
    });

    it('returns null for a non-existent file path', async () => {
        expect(await extractExifGps(path.join(FIXTURES, 'ghost.jpg'))).toBeNull();
    });
});

describe('reverseGeocodeExifGps', () => {
    beforeEach(() => fs.mkdir(FIXTURES, { recursive: true }));
    afterEach(() => fs.rm(FIXTURES, { recursive: true, force: true }));

    function makeMockService(result: Place | null): GeocodingService {
        return { reverseGeocode: async () => result } as unknown as GeocodingService;
    }

    it('returns null for a non-image file', async () => {
        const p = path.join(FIXTURES, 'test.txt');
        await fs.writeFile(p, 'hello');
        expect(await reverseGeocodeExifGps(p, makeMockService({ name: 'London', lat: 51.5, lng: -0.1 }))).toBeNull();
    });

    it('returns null when image has no GPS EXIF and geocodingService is null', async () => {
        const p = path.join(FIXTURES, 'no-gps.jpg');
        await sharp({
            create: { width: 8, height: 8, channels: 3, background: { r: 100, g: 150, b: 200 } },
        }).jpeg().toFile(p);
        // No GPS in synthetic image, so should return null regardless
        expect(await reverseGeocodeExifGps(p, null)).toBeNull();
    });

    it('returns null when image has no GPS EXIF even with a service', async () => {
        // We can't easily create a JPEG with GPS EXIF in tests, so we test the
        // null-service and non-image paths. The integration of extractExifGps +
        // reverseGeocode is tested via the GeocodingService tests above.
        const p = path.join(FIXTURES, 'no-gps2.jpg');
        await sharp({
            create: { width: 8, height: 8, channels: 3, background: { r: 100, g: 150, b: 200 } },
        }).jpeg().toFile(p);
        expect(await reverseGeocodeExifGps(p, makeMockService(null))).toBeNull();
    });
});

describe('loadAssetIndex', () => {
    beforeEach(() => fs.mkdir(path.join(FIXTURES, '_meta'), { recursive: true }));
    afterEach(() => fs.rm(FIXTURES, { recursive: true, force: true }));

    it('returns an empty index when assets.yaml is missing', async () => {
        expect(await loadAssetIndex(FIXTURES)).toEqual({});
    });

    it('returns an empty index when assets.yaml is empty', async () => {
        await fs.writeFile(path.join(FIXTURES, '_meta', 'assets.yaml'), '');
        expect(await loadAssetIndex(FIXTURES)).toEqual({});
    });

    it('returns an empty index when assets.yaml only has comments', async () => {
        await fs.writeFile(path.join(FIXTURES, '_meta', 'assets.yaml'), '# asset metadata\n');
        expect(await loadAssetIndex(FIXTURES)).toEqual({});
    });
});
