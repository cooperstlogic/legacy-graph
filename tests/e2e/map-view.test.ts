import { test, expect } from '@playwright/test';

test.describe('Map View', () => {
    test('basemap loads without worker or runtime errors', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text());
        });

        await page.goto('/map');

        // MapLibre only reports loaded() once its style and sources have been
        // processed by the tile worker, so a worker that fails to start (e.g. a
        // bundler-unresolvable worker URL) leaves this false forever.
        await expect
            .poll(
                () => page.evaluate(() => {
                    const map = (window as unknown as { __map?: { loaded: () => boolean } }).__map;
                    return map?.loaded() ?? false;
                }),
                { timeout: 20_000 },
            )
            .toBe(true);

        expect(errors.filter((e) => /worker/i.test(e))).toEqual([]);
    });
});
