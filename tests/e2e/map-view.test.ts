import { test, expect, type Page } from '@playwright/test';

type TestMap = {
    loaded: () => boolean;
    jumpTo: (opts: { center: [number, number]; zoom: number }) => void;
    once: (event: string, cb: () => void) => void;
    project: (lngLat: [number, number]) => { x: number; y: number };
    getContainer: () => HTMLElement;
};

/**
 * Jumps the map to `center`/`zoom` once `window.__map` is loaded and has been
 * the same instance for 500ms (React Strict Mode mounts MapView twice in dev),
 * then resolves with the page coordinates of `center` after the map settles.
 */
async function jumpAndProject(page: Page, center: [number, number], zoom: number): Promise<{ x: number; y: number }> {
    return page.evaluate(({ center, zoom }) => new Promise<{ x: number; y: number }>((resolve, reject) => {
        const deadline = Date.now() + 20_000;
        let last: TestMap | undefined;
        let stableSince = 0;
        const tick = () => {
            const map = (window as unknown as { __map?: TestMap }).__map;
            if (map && map === last && map.loaded() && Date.now() - stableSince >= 500) {
                map.once('idle', () => {
                    const p = map.project(center);
                    const box = map.getContainer().getBoundingClientRect();
                    resolve({ x: box.left + p.x, y: box.top + p.y });
                });
                map.jumpTo({ center, zoom });
                return;
            }
            if (map !== last) { last = map; stableSince = Date.now(); }
            if (Date.now() > deadline) { reject(new Error('timed out waiting for a stable, loaded map')); return; }
            setTimeout(tick, 50);
        };
        tick();
    }), { center, zoom });
}

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

    test.describe('pin click', () => {
        // An isolated spot so the click can only hit this person's pin.
        const REYKJAVIK: [number, number] = [-21.9426, 64.1466];
        let personId: string | undefined;

        test.beforeAll(async ({ request }) => {
            const res = await request.post('http://localhost:3000/api/people', {
                data: {
                    names: [{ first: 'Pinclick', last: 'Testperson', primary: true }],
                    sex: 'F',
                    events: [{
                        type: 'birth',
                        date: '1850',
                        sort_date: '1850-01-01',
                        location: { name: 'Reykjavík, Iceland', lat: REYKJAVIK[1], lng: REYKJAVIK[0] },
                    }],
                },
            });
            expect(res.ok()).toBeTruthy();
            personId = (await res.json()).id;
        });

        test.afterAll(async ({ request }) => {
            if (personId) await request.delete(`http://localhost:3000/api/people/${personId}`);
        });

        test('clicking a pin opens the event drawer', async ({ page }) => {
            await page.goto('/map?t=1840&t_end=1860');
            // Pins are fully opaque from zoom 5 up.
            const pin = await jumpAndProject(page, REYKJAVIK, 6);
            await page.mouse.click(pin.x, pin.y);

            await expect(page.getByText('Pinclick Testperson')).toBeVisible({ timeout: 5_000 });
        });
    });
});
