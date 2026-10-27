import { expect, test } from '@playwright/test';

async function focusedName(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return '';
    const label = el.getAttribute('aria-label');
    if (label) return label.trim();
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  });
}

test('keyboard reaches the controls, records, and closes the sheet @chromium', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.fr-header__name')).toHaveText('FlipRec');

  const order = [];
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Tab');
    order.push(await focusedName(page));
  }
  expect(order).toEqual([
    'Start recording',
    'Play forward',
    'Play reversed',
    'Share reversed',
    'More options',
  ]);

  await page.keyboard.press('Enter');
  await expect(page.locator('#fr-more-sheet[open]:not(.fr-sheet--prep)')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#fr-more-sheet')).toBeHidden();
  await expect(page.locator('#fr-more-button')).toBeFocused();

  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+Tab');
  expect(await focusedName(page)).toBe('Start recording');
  await page.keyboard.press('Space');
  await expect(page.locator('.fr-live')).toContainText('Recording started');
  await expect(page.locator('.fr-status')).toHaveText('Recording', { timeout: 2000 });
});
