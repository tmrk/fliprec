import { expect } from '@playwright/test';

const FILENAME = /^fliprec-(reversed|original)-\d{8}-\d{6}\.m4a$/;

export function trackErrors(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

export function statusLocator(page) {
  return page.locator('.fr-status');
}

export async function readTimer(page) {
  const text = await page.locator('.fr-timer').evaluate((el) => (el.textContent || '').trim());
  return text;
}

/** @param {string} text */
export function parseClock(text) {
  const match = String(text).trim().match(/^(\d+):(\d{2})\.(\d)$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 10;
}

/**
 * Open More and feed the hidden file input.
 * @param {import('@playwright/test').Page} page
 * @param {Buffer} bytes
 * @param {{ closeSheet?: boolean }} [options]
 */
export async function importAudio(page, bytes, { closeSheet = false } = {}) {
  await page.getByRole('button', { name: 'More options' }).click();
  const sheet = page.locator('#fr-more-sheet');
  await expect(sheet).toBeVisible();
  await page.locator('input.fr-file').setInputFiles({
    name: 'fixture.wav',
    mimeType: 'audio/wav',
    buffer: bytes,
  });
  await expect(statusLocator(page)).toHaveText('Ready', { timeout: 20_000 });
  if (closeSheet) {
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toBeHidden();
  }
}

export async function waitForShareReady(page) {
  await expect(page.locator('.fr-secondary__share')).toHaveAttribute('aria-disabled', 'false', {
    timeout: 45_000,
  });
}

export const M4A_FILENAME = FILENAME;

/**
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} click
 */
export async function clickDownload(page, click) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    click(),
  ]);
  return download;
}

/** @param {import('@playwright/test').Page} page */
export async function installShareShim(page, mode) {
  await page.addInitScript((variant) => {
    const calls = [];
    window.__fliprecShares = calls;

    function define(name, value) {
      const descriptor = { configurable: true, writable: true, value };
      try {
        Object.defineProperty(navigator, name, descriptor);
      } catch {
        Object.defineProperty(Navigator.prototype, name, descriptor);
      }
    }

    if (variant === 'unsupported') {
      define('canShare', undefined);
      define('share', () => Promise.reject(new Error('share should not be called')));
      return;
    }

    define('canShare', () => true);
    define('share', (data) => {
      const files = Array.from((data && data.files) || []);
      calls.push({
        keys: data && typeof data === 'object' ? Object.keys(data) : [],
        files: files.map((file) => ({
          name: file.name,
          type: file.type,
          size: file.size,
          isFile: typeof File !== 'undefined' && file instanceof File,
        })),
      });
      if (variant === 'abort') {
        return Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));
      }
      return Promise.resolve();
    });
  }, mode);
}
