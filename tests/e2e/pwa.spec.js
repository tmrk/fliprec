import { stat } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { pngSize } from '../helpers/png.js';
import { makeToneWav } from '../helpers/signals.js';
import { clickDownload, importAudio, waitForShareReady } from './helpers/app.js';

const wav = makeToneWav(0.8);

test('manifest, icons, and apple touch icon are served', async ({ page, baseURL }) => {
  await page.goto('./');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifestUrl = new URL(href, baseURL);
  expect(manifestUrl.pathname.startsWith('/fliprec/')).toBe(true);

  const response = await page.request.get(manifestUrl.toString());
  expect(response.status()).toBe(200);
  const manifest = await response.json();
  expect(manifest.name).toBe('FlipRec');
  expect(manifest.start_url).toBe('./');
  expect(manifest.scope).toBe('./');
  expect(manifest.display).toBe('standalone');
  expect(Array.isArray(manifest.icons)).toBe(true);
  expect(manifest.icons.length).toBeGreaterThan(0);

  for (const icon of manifest.icons) {
    const iconUrl = new URL(icon.src, manifestUrl);
    expect(iconUrl.pathname.startsWith('/fliprec/')).toBe(true);
    const iconResponse = await page.request.get(iconUrl.toString());
    expect(iconResponse.status(), iconUrl.pathname).toBe(200);
    expect(iconResponse.headers()['content-type'] || '').toContain('image/png');
    const [width, height] = String(icon.sizes).split('x').map((part) => Number(part));
    const size = pngSize(await iconResponse.body());
    expect(size, icon.src).toEqual({ width, height });
  }

  const appleHref = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect(appleHref).toBeTruthy();
  const appleUrl = new URL(appleHref, baseURL);
  expect(appleUrl.pathname.startsWith('/fliprec/')).toBe(true);
  const apple = await page.request.get(appleUrl.toString());
  expect(apple.status()).toBe(200);
  expect(apple.headers()['content-type'] || '').toContain('image/png');
});

test('service worker serves the shell offline', async ({ page, context }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('./');
  const scope = await page.evaluate(async () => {
    const ready = navigator.serviceWorker.ready;
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('service worker was not ready')), 20_000);
    });
    const registration = await Promise.race([ready, timeout]);
    return registration.scope;
  });
  expect(scope).toBe('http://localhost:4173/fliprec/');
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state ?? '')).toBe('activated');

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.fr-header__name')).toHaveText('FlipRec');
  await expect(page.locator('button.fr-record')).toBeVisible();

  if (testInfo.project.name !== 'chromium') return;

  await importAudio(page, wav);
  await waitForShareReady(page);
  const download = await clickDownload(page, () => page.getByRole('button', { name: 'Save reversed M4A' }).click());
  expect(download.suggestedFilename()).toMatch(/^fliprec-reversed-\d{8}-\d{6}\.m4a$/);
  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  expect((await stat(filePath)).size).toBeGreaterThan(1000);
});
