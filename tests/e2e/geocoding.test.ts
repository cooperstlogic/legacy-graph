import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const GPS_JPG_PATH = path.resolve('./tests/e2e/fixtures/gps-london.jpg');

// Use a run-specific suffix to avoid filename dedup collisions across runs.
const RUN_ID = Date.now();
const GPS_IMAGE_FILENAME = `gps-london-${RUN_ID}.jpg`;
// AssetsPage shows the filename minus extension with - and _ as spaces
const GPS_IMAGE_DISPLAY_NAME = `gps london ${RUN_ID}`;

test.describe('CUJ 5: Geocoding — Place Search & Reverse Geocoding', () => {
    let personId: string;
    const uploadedAssets: string[] = [];

    // Create a fresh person before all tests.
    test.beforeAll(async ({ request }) => {
        // Wait for hydration
        let ready = false;
        for (let i = 0; i < 60; i++) {
            const status = await request.get('http://localhost:3000/api/system/status');
            const body = await status.json();
            if (body.hydrationState === 'ready') { ready = true; break; }
            await new Promise(r => setTimeout(r, 1000));
        }
        expect(ready, 'Hydration did not reach ready within 60s').toBe(true);

        // Verify GeoNames DB is available (place search returns results, not errors)
        const placeCheck = await request.get('http://localhost:3000/api/places/search?q=London');
        if (!placeCheck.ok()) {
            test.skip();
            return;
        }
        const places = await placeCheck.json();
        if (!Array.isArray(places) || places.length === 0) {
            test.skip();
            return;
        }

        const res = await request.post('http://localhost:3000/api/people', {
            data: {
                names: [{ first: 'Geo', last: 'TestPerson', primary: true }],
                sex: 'M',
            },
        });
        expect(res.ok()).toBeTruthy();
        personId = (await res.json()).id;
    });

    test.afterAll(async ({ request }) => {
        // permanent=true deletes the file too; a bare unlink leaves a geotagged
        // asset behind that a rerun against the same data dir would also find.
        for (const filename of uploadedAssets) {
            await request.delete(`http://localhost:3000/api/people/${personId}/media/${filename}?permanent=true`);
        }
        if (personId) await request.delete(`http://localhost:3000/api/people/${personId}`);
    });

    test('place search in event editor shows results, selects a place, and persists location', async ({ page }) => {
        await page.goto(`/people/${personId}`);

        // Open the Add Event dialog
        await page.getByRole('button', { name: 'Add Event' }).click();
        await expect(page.getByRole('heading', { name: /Add Event|New Event|Event/i })).toBeVisible({ timeout: 5_000 });

        // Type "London" in the place search combobox
        const placeInput = page.locator('input[placeholder="City, Country"]');
        await expect(placeInput).toBeVisible();
        await placeInput.fill('London');

        // Wait for the debounced search to return and dropdown to appear
        // Dropdown items are buttons inside the combobox dropdown
        const dropdownItem = page.locator('button').filter({ hasText: 'London' }).first();
        await expect(dropdownItem).toBeVisible({ timeout: 10_000 });

        // The dropdown should show a country code (e.g. "GB")
        const dropdown = page.locator('.absolute.z-50');
        await expect(dropdown).toBeVisible();

        // Select the first result
        await dropdownItem.click();

        // After selection, coordinates should appear below the input (green text)
        const coordsText = page.locator('p').filter({ hasText: /°[NS],\s*\d/ });
        await expect(coordsText).toBeVisible({ timeout: 3_000 });

        // The place input should now show the formatted place name
        await expect(placeInput).not.toHaveValue('London');
        const inputValue = await placeInput.inputValue();
        expect(inputValue).toContain('London');

        // Save the event
        await page.getByRole('button', { name: /Save|Add/i }).click();

        // Wait for dialog to close
        await expect(page.getByRole('heading', { name: /Add Event|New Event|Event/i })).not.toBeVisible({ timeout: 5_000 });

        // The timeline should show the location with a MapPin icon
        const locationText = page.locator('span.truncate').filter({ hasText: 'London' });
        await expect(locationText).toBeVisible({ timeout: 5_000 });

        // Reload and verify persistence
        await page.reload();
        await expect(page.locator('span.truncate').filter({ hasText: 'London' })).toBeVisible({ timeout: 10_000 });
    });

    test('image upload with EXIF GPS auto-populates location via reverse geocoding', async ({ page }) => {
        // Verify the fixture exists
        expect(fs.existsSync(GPS_JPG_PATH)).toBe(true);

        // Upload via the person's Assets tab
        await page.goto(`/people/${personId}`);
        await page.getByRole('tab', { name: 'Assets' }).click();

        const fileChooserPromise = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Browse files' }).click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles({
            name: GPS_IMAGE_FILENAME,
            mimeType: 'image/jpeg',
            buffer: fs.readFileSync(GPS_JPG_PATH),
        });

        // Wait for upload to complete — the image should appear in the gallery
        const galleryImage = page.locator(`img[alt*="gps london"]`);
        await expect(galleryImage).toBeVisible({ timeout: 10_000 });
        uploadedAssets.push(GPS_IMAGE_FILENAME);

        // Navigate to global assets page to check metadata (location is shown there)
        await page.goto('/assets');

        // The grid is virtualized and sorted by name, so with older gps-london-*
        // assets in the data dir this run's card may sort past the rendered rows.
        // Searching the unique filename leaves only this card in the grid.
        await page.getByPlaceholder('Search or @mention…').fill(GPS_IMAGE_FILENAME);

        // The asset card for our uploaded image should show a reverse-geocoded location.
        // With the London coordinates (51.5074°N, 0.1278°W), the GeoNames DB should
        // resolve to a place name containing "London" (e.g. "London", "City of London").
        // The location text appears in the asset card info panel.
        // Scope to this run's card: every ancestor of the card also contains its
        // image and title, and .last() picks the innermost (the card itself).
        // Other London-geotagged assets on the page must not satisfy the check.
        const assetCard = page.locator('div')
            .filter({ has: page.getByRole('img', { name: GPS_IMAGE_DISPLAY_NAME, exact: true }) })
            .filter({ has: page.locator(`p[title="${GPS_IMAGE_DISPLAY_NAME}"]`) })
            .last();
        await expect(assetCard).toBeVisible({ timeout: 10_000 });

        // Check that reverse-geocoded location metadata is displayed.
        // The exact place name depends on the GeoNames DB content, but for 51.5°N 0.13°W
        // it should include "London" or similar. We check that location text is present.
        const locationSpan = assetCard.locator('span').filter({ hasText: /London|Westminster|City of/i });
        await expect(locationSpan).toBeVisible({ timeout: 5_000 });
    });
});
