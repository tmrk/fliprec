import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import {
  parseClock,
  readTimer,
  statusLocator,
  trackErrors,
} from './helpers/app.js';

const shimPath = fileURLToPath(new URL('./helpers/audioClockShim.js', import.meta.url));

test.describe('record and play', () => {
  /** @type {string[]} */
  let errors;

  test.beforeEach(async ({ page }) => {
    errors = trackErrors(page);
  });

  test.afterEach(() => {
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('records, plays, pauses, reverses, and ends (emulated audio clock) @chromium', async ({ page }) => {
    await page.addInitScript({ path: shimPath });
    await page.goto('./');

    const status = statusLocator(page);
    const record = page.locator('button.fr-record');
    const forward = page.locator('button.fr-tile--forward');
    const reverse = page.locator('button.fr-tile--reverse');

    await expect(status).toHaveText('Tap to record');
    await expect(forward).toHaveAttribute('aria-disabled', 'true');
    await expect(reverse).toHaveAttribute('aria-disabled', 'true');

    await record.click();
    await expect(status).toHaveText('Recording', { timeout: 2000 });

    const earlier = parseClock(await readTimer(page));
    await page.waitForTimeout(500);
    const later = parseClock(await readTimer(page));
    expect(later).toBeGreaterThan(earlier);

    await page.waitForTimeout(2000);
    await record.click();
    await expect(status).toHaveText('Ready', { timeout: 20_000 });
    await expect(forward).not.toHaveAttribute('aria-disabled');
    await expect(reverse).not.toHaveAttribute('aria-disabled');

    const shown = parseClock(await readTimer(page));
    expect(shown).toBeGreaterThanOrEqual(2);
    expect(shown).toBeLessThanOrEqual(4.5);

    await forward.click();
    await expect(status).toHaveText('Playing');
    await expect(forward).toHaveAttribute('aria-pressed', 'true');
    await expect(reverse).toHaveAttribute('aria-pressed', 'false');

    await forward.click();
    await expect(status).toHaveText('Paused');
    const pausedAt = await readTimer(page);
    await page.waitForTimeout(300);
    expect(await readTimer(page)).toBe(pausedAt);
    expect(pausedAt).toMatch(/^\d+:\d{2}\.\d$/);

    // Folded from smoke.spec.js: seeking while paused does not need the clock.
    const slider = page.getByRole('slider', { name: 'Playback position' });
    const box = await slider.boundingBox();
    expect(box).toBeTruthy();
    await slider.click({ position: { x: box.width * 0.25, y: box.height / 2 } });
    await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(15);
    await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(35);

    await forward.click();
    await expect(status).toHaveText('Playing');
    await expect(forward).toHaveAttribute('aria-pressed', 'true');

    await reverse.click();
    await expect(status).toHaveText('Playing reversed');
    await expect(reverse).toHaveAttribute('aria-pressed', 'true');
    await expect(forward).toHaveAttribute('aria-pressed', 'false');
    expect(await forward.getAttribute('aria-pressed')).not.toBe('true');

    await expect(status).toHaveText('Ready', { timeout: 20_000 });
    await expect(forward).toHaveAttribute('aria-pressed', 'false');
    await expect(reverse).toHaveAttribute('aria-pressed', 'false');
  });

  test('rapid record taps settle @chromium', async ({ page }) => {
    await page.goto('./');
    const status = statusLocator(page);
    const record = page.locator('button.fr-record');

    await record.click();
    await expect(status).toHaveText('Recording', { timeout: 2000 });
    await page.waitForTimeout(1000);
    await record.click();
    await expect(status).toHaveText('Ready', { timeout: 20_000 });

    await record.evaluate(async (button) => {
      for (let i = 0; i < 5; i += 1) {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    });

    await expect.poll(async () => (await status.textContent())?.trim() ?? '', {
      timeout: 5000,
    }).toMatch(/^(Recording|Ready)$/);
  });
});
