import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Minimal 1×1 transparent PNG — valid image bytes the server will accept
const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
]);

const MD_CONTENT = [
    '# My Ancestor Notes',
    '',
    'This is a **formatted** document about family history.',
    '',
    '- Fact one',
    '- Fact two',
].join('\n');

// Use a run-specific suffix so filenames are unique across test runs and never
// trigger the backend's dedup renaming (which would break the filename assertions).
const RUN_ID = Date.now();
const IMAGE_FILENAME = `family-portrait-${RUN_ID}.png`;
const MD_FILENAME = `ancestor-notes-${RUN_ID}.md`;

// Mirror the frontend's display name transform: strip extension, replace hyphens/underscores with spaces.
function displayName(filename: string): string {
    const dot = filename.lastIndexOf('.');
    return (dot > 0 ? filename.slice(0, dot) : filename).replace(/[_-]/g, ' ');
}

test.describe('CUJ 4: Asset Management — Upload, View, Reject', () => {
    let personId: string;
    const uploadedAssets: string[] = [];

    // Create a fresh person with no assets before all tests in this suite.
    // Poll until hydration is complete before creating the person — the status
    // endpoint responds immediately on startup but data routes return 503 until ready.
    test.beforeAll(async ({ request }) => {
        let ready = false;
        let lastState: string | undefined;
        for (let i = 0; i < 60; i++) {
            const status = await request.get('http://localhost:3000/api/system/status');
            const body = await status.json();
            lastState = body.hydrationState;
            if (lastState === 'ready') { ready = true; break; }
            await new Promise(r => setTimeout(r, 1000));
        }
        expect(ready, `Hydration did not reach 'ready' within 60s (last: ${lastState})`).toBe(true);

        const res = await request.post('http://localhost:3000/api/people', {
            data: {
                names: [{ first: 'Asset', last: 'TestPerson', primary: true }],
                sex: 'F',
            },
        });
        expect(res.ok()).toBeTruthy();
        personId = (await res.json()).id;
    });

    // Clean up uploaded assets and the test person
    test.afterAll(async ({ request }) => {
        for (const filename of uploadedAssets) {
            await request.delete(`http://localhost:3000/api/people/${personId}/media/${filename}?permanent=true`);
        }
        if (personId) await request.delete(`http://localhost:3000/api/people/${personId}`);
    });

    test('uploads an image, preserves the original filename, and shows it in the gallery', async ({ page }) => {
        await page.goto(`/people/${personId}`);
        await page.getByRole('tab', { name: 'Assets' }).click();

        // Person starts with no assets
        await expect(page.getByText('No assets yet')).toBeVisible();

        // Upload via the Browse files button file chooser
        const fileChooserPromise = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Browse files' }).click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles({
            name: IMAGE_FILENAME,
            mimeType: 'image/png',
            buffer: PNG_BYTES,
        });

        // Gallery should show the image — alt text uses the display name (extension stripped, hyphens→spaces)
        const galleryImage = page.locator(`img[alt="${displayName(IMAGE_FILENAME)}"]`);
        await expect(galleryImage).toBeVisible({ timeout: 10_000 });
        uploadedAssets.push(IMAGE_FILENAME);

        // First uploaded image becomes the primary avatar — Primary badge appears
        await expect(page.getByText('Primary')).toBeVisible();

        // The avatar in the profile header should now render an <img> (photo, not initials)
        // CustomAvatar renders an AvatarImage (<img>) when photoFilename is set
        const avatarImg = page.locator('[class*="rounded-full"] img').first();
        await expect(avatarImg).toBeVisible();
    });

    test('uploads a markdown file and renders it as formatted HTML in the lightbox', async ({ page }) => {
        await page.goto(`/people/${personId}`);
        await page.getByRole('tab', { name: 'Assets' }).click();

        // Upload .md file
        const fileChooserPromise = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Browse files' }).click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles({
            name: MD_FILENAME,
            mimeType: 'text/markdown',
            buffer: Buffer.from(MD_CONTENT),
        });
        uploadedAssets.push(MD_FILENAME);

        // Gallery card should appear with the display name (extension stripped, hyphens→spaces)
        await expect(page.getByText(displayName(MD_FILENAME))).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText('Markdown')).toBeVisible();

        // Hover the document card to reveal the overlay button, then open the lightbox
        const docCard = page.locator('div.group').filter({ hasText: displayName(MD_FILENAME) });
        await docCard.hover();
        await page.getByTitle('View document').click();

        // Lightbox should render formatted HTML via ReactMarkdown, not raw markdown syntax
        const prose = page.locator('.prose');
        await expect(prose).toBeVisible({ timeout: 5_000 });

        // The `# My Ancestor Notes` heading should be rendered as an <h1>, not raw text
        await expect(prose.locator('h1')).toContainText('My Ancestor Notes');

        // The **formatted** text should be rendered as <strong>
        await expect(prose.locator('strong')).toContainText('formatted');

        // Raw markdown syntax characters must NOT be visible as plain text
        await expect(page.getByText(/^# My Ancestor Notes/)).not.toBeVisible();
        await expect(page.getByText(/\*\*formatted\*\*/)).not.toBeVisible();

        // Close the lightbox
        await page.keyboard.press('Escape');
        await expect(prose).not.toBeVisible();
    });

    test('rejects a disallowed file type with a descriptive toast message', async ({ page }) => {
        await page.goto(`/people/${personId}`);
        await page.getByRole('tab', { name: 'Assets' }).click();

        // Attempt to upload a shell script (not in the allowed list)
        const fileChooserPromise = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Browse files' }).click();
        const fileChooser = await fileChooserPromise;
        await fileChooser.setFiles({
            name: 'malicious.sh',
            mimeType: 'application/x-sh',
            buffer: Buffer.from('#!/bin/sh\necho hello'),
        });

        // The specific backend error should appear in the toast — NOT the generic "Failed to upload asset."
        await expect(page.getByText('File type not allowed')).toBeVisible({ timeout: 10_000 });

        // The disallowed file must NOT appear in the gallery
        await expect(page.getByText('malicious.sh')).not.toBeVisible();
    });
});

test.describe('Bulk upload dialog', () => {
    test('shows a painted thumbnail for images and an icon for other files', async ({ page }) => {
        await page.goto('/assets');
        await page.getByRole('button', { name: 'Upload' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.locator('input[type="file"]').setInputFiles([
            { name: 'gps-london.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(path.resolve('./tests/e2e/fixtures/gps-london.jpg')) },
            { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('plain notes') },
        ]);

        const thumb = dialog.getByRole('img', { name: 'gps-london.jpg' });
        await expect(thumb).toBeVisible();
        // Painted, not just present: an <img> has decoded pixels, a <canvas> has
        // non-transparent pixels at its centre.
        await expect.poll(() => thumb.evaluate((el) => {
            if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0;
            if (el instanceof HTMLCanvasElement) {
                const ctx = el.getContext('2d');
                return !!ctx && ctx.getImageData(el.width / 2, el.height / 2, 1, 1).data[3] > 0;
            }
            return false;
        })).toBe(true);

        await expect(dialog.getByText('notes.txt')).toBeVisible();
        await expect(dialog.getByRole('img', { name: 'notes.txt' })).toHaveCount(0);
    });
});
