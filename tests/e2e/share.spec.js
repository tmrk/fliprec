import { expect, test } from '@playwright/test';
import { makeToneWav } from '../helpers/signals.js';
import { importAudio, installShareShim, waitForShareReady } from './helpers/app.js';

const wav = makeToneWav(1);

function shareButton(page) {
  return page.locator('.fr-secondary').getByRole('button', { name: 'Share reversed' });
}

async function prepare(page) {
  await importAudio(page, wav, { closeSheet: true });
  await waitForShareReady(page);
}

test.describe('share reversed', () => {
  test('calls navigator.share with the M4A file only @chromium', async ({ page }) => {
    test.setTimeout(90_000);
    await installShareShim(page, 'share');
    await page.goto('./');
    await prepare(page);

    await shareButton(page).click();
    await expect.poll(() => page.evaluate(() => window.__fliprecShares.length)).toBe(1);

    const call = await page.evaluate(() => window.__fliprecShares[0]);
    expect(call.keys).toEqual(['files']);
    expect(call.files).toHaveLength(1);
    const file = call.files[0];
    expect(file.isFile).toBe(true);
    expect(file.name).toMatch(/^fliprec-reversed-\d{8}-\d{6}\.m4a$/);
    expect(file.type).toBe('audio/mp4');
    expect(file.size).toBeGreaterThan(1000);
  });

  test('AbortError stays quiet @chromium', async ({ page }) => {
    test.setTimeout(90_000);
    await installShareShim(page, 'abort');
    await page.goto('./');
    await prepare(page);

    /** @type {string[]} */
    const downloads = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));

    await shareButton(page).click();
    await expect.poll(() => page.evaluate(() => window.__fliprecShares.length)).toBe(1);
    await page.waitForTimeout(600);
    expect(downloads).toEqual([]);
    await expect(page.locator('.fr-toast')).toHaveCount(0);
  });

  test('missing canShare downloads and tells the user @chromium', async ({ page }) => {
    test.setTimeout(90_000);
    await installShareShim(page, 'unsupported');
    await page.goto('./');
    await prepare(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      shareButton(page).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^fliprec-reversed-\d{8}-\d{6}\.m4a$/);
    await expect(page.locator('.fr-toast')).toContainText(
      "Sharing isn't available here, so the file was saved instead",
    );
  });
});
