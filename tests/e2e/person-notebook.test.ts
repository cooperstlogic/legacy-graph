import { test, expect } from '@playwright/test';

test.describe('Person notebook', () => {
    let personId: string | undefined;

    test.beforeAll(async ({ request }) => {
        const res = await request.post('http://localhost:3000/api/people', {
            data: { names: [{ first: 'Notebook', last: 'Testperson', primary: true }], sex: 'U' },
        });
        expect(res.ok()).toBeTruthy();
        personId = (await res.json()).id;
    });

    test.afterAll(async ({ request }) => {
        if (personId) await request.delete(`http://localhost:3000/api/people/${personId}`);
    });

    test('saving right after typing keeps the latest edits', async ({ page, request }) => {
        await page.goto(`/people/${personId}`);
        await page.getByRole('tab', { name: 'Notebook' }).click();
        await page.getByRole('button', { name: 'Edit' }).click();

        const editor = page.locator('[contenteditable="true"]').first();
        await editor.click();
        await page.keyboard.type('Notes typed just before saving');
        await page.getByRole('button', { name: 'Save' }).click();

        await expect.poll(async () => {
            const res = await request.get(`http://localhost:3000/api/people/${personId}`);
            return (await res.json()).scrapbook_md as string;
        }, { timeout: 10_000 }).toContain('Notes typed just before saving');
    });
});
