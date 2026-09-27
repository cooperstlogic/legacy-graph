import { test, expect, type APIRequestContext } from '@playwright/test';

const API = 'http://localhost:3000/api/stories';

async function getStory(request: APIRequestContext, id: string) {
    const res = await request.get(`${API}/${id}`);
    expect(res.ok()).toBeTruthy();
    return res.json() as Promise<{ content: string; metadata: { title: string } }>;
}

test.describe('Stories', () => {
    const createdIds: string[] = [];

    test.afterAll(async ({ request }) => {
        for (const id of createdIds) await request.delete(`${API}/${id}`);
    });

    test('creating a story saves it and opens it', async ({ page, request }) => {
        await page.goto('/stories/new');
        await page.getByPlaceholder('Story title…').fill('E2E Created Story');
        const editor = page.locator('[contenteditable="true"]').first();
        await editor.click();
        await page.keyboard.type('Written in the new-story editor');
        await expect(editor).toContainText('Written in the new-story editor');
        await page.getByRole('button', { name: 'Create' }).click();

        await page.waitForURL(/\/stories\/(?!new)[^/?]+$/, { timeout: 10_000 });
        const id = new URL(page.url()).pathname.split('/').pop()!;
        createdIds.push(id);

        const story = await getStory(request, id);
        expect(story.metadata.title).toBe('E2E Created Story');
        expect(story.content).toContain('Written in the new-story editor');
    });

    test.describe('editing an existing story', () => {
        let id: string;

        test.beforeEach(async ({ request }) => {
            const res = await request.post(API, { data: { title: 'E2E Original Title', content: 'Original body' } });
            expect(res.ok()).toBeTruthy();
            id = (await res.json()).id;
            createdIds.push(id);
        });

        test('auto-saves edits without clobbering the editor', async ({ page, request }) => {
            await page.goto(`/stories/${id}`);
            await page.getByRole('button', { name: 'Edit Story' }).click();
            await page.waitForURL(/mode=edit/);

            const editor = page.locator('[contenteditable="true"]').first();
            await editor.click();
            await page.keyboard.press('End');
            await page.keyboard.type(' plus an autosaved line');

            // 3 s debounce, then the save refreshes the cached story; the
            // in-progress editor content must survive that refresh.
            await expect.poll(async () => (await getStory(request, id)).content, { timeout: 10_000 })
                .toContain('plus an autosaved line');
            await expect(editor).toContainText('Original body plus an autosaved line');
        });

        test('saving right after typing keeps the latest edits', async ({ page, request }) => {
            await page.goto(`/stories/${id}`);
            await page.getByRole('button', { name: 'Edit Story' }).click();
            await page.waitForURL(/mode=edit/);

            const editor = page.locator('[contenteditable="true"]').first();
            await editor.click();
            await page.keyboard.press('End');
            await page.keyboard.type(' and a last-second line');
            await page.getByRole('button', { name: 'Save' }).click();

            await expect(page).not.toHaveURL(/mode=edit/, { timeout: 10_000 });
            expect((await getStory(request, id)).content).toContain('Original body and a last-second line');
        });

        test('discard restores the story as it was before editing', async ({ page, request }) => {
            await page.goto(`/stories/${id}`);
            await page.getByRole('button', { name: 'Edit Story' }).click();
            await page.waitForURL(/mode=edit/);

            await page.getByPlaceholder('Story title…').fill('E2E Edited Title');
            await expect.poll(async () => (await getStory(request, id)).metadata.title, { timeout: 10_000 })
                .toBe('E2E Edited Title');

            await page.getByRole('button', { name: 'Discard' }).click();
            await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();

            await expect(page).not.toHaveURL(/mode=edit/, { timeout: 10_000 });
            expect((await getStory(request, id)).metadata.title).toBe('E2E Original Title');
            await expect(page.getByText('E2E Original Title').first()).toBeVisible();
        });
    });
});
