import { expect, test } from '@playwright/test';

test('Sounds switch toggles and survives a reload', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.fr-header__name')).toHaveText('FlipRec');

  await page.getByRole('button', { name: 'More options' }).click();
  const sheet = page.locator('#fr-more-sheet');
  await expect(sheet).toBeVisible();

  const toggle = sheet.getByRole('switch', { name: 'Sounds' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toBeHidden();

  await page.reload();
  await expect(page.locator('.fr-header__name')).toHaveText('FlipRec');
  await page.getByRole('button', { name: 'More options' }).click();
  await expect(sheet.getByRole('switch', { name: 'Sounds' })).toHaveAttribute('aria-checked', 'false');
});
