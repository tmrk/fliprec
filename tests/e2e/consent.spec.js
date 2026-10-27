import { expect, test } from '@playwright/test';
import { makeToneWav } from '../helpers/signals.js';
import { importAudio, statusLocator } from './helpers/app.js';

const wav = makeToneWav(0.8);

function isForeign(url) {
  try {
    const host = new URL(url).hostname;
    if (!host) return false;
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]';
  } catch {
    return false;
  }
}

test('no consent card and no off-device requests during import', async ({ page }) => {
  test.setTimeout(90_000);
  /** @type {string[]} */
  const foreign = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (isForeign(url)) {
      foreign.push(url);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  await page.goto('./');
  await expect(page.locator('.fr-consent')).toHaveCount(0);
  await expect(page.getByText('Allow anonymous usage statistics?')).toHaveCount(0);

  await importAudio(page, wav, { closeSheet: true });
  await expect(statusLocator(page)).toHaveText('Ready');
  // Give the encode worker a moment to fetch anything it might want.
  await page.waitForTimeout(3000);

  const gtm = foreign.filter((url) => url.includes('googletagmanager'));
  expect(gtm, gtm.join('\n')).toEqual([]);
  expect(foreign, foreign.join('\n')).toEqual([]);
});
