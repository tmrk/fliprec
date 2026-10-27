import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  [320, 568],
  [375, 548],
  [375, 667],
  [390, 844],
  [430, 932],
  [844, 390],
  [412, 915],
  [1440, 900],
];

test.beforeAll(async () => {
  await mkdir('tests/e2e/__output__', { recursive: true });
});

for (const [width, height] of VIEWPORTS) {
  test(`fits ${width}×${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.goto('./');
    await expect(page.locator('.fr-header__name')).toHaveText('FlipRec');

    const record = page.locator('button.fr-record');
    const tiles = page.locator('button.fr-tile');
    await expect(record).toBeVisible();
    await expect(tiles).toHaveCount(2);

    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      return {
        x: Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth,
        y: Math.max(root.scrollHeight, body.scrollHeight) - root.clientHeight,
      };
    });
    expect(overflow.x, 'horizontal overflow').toBeLessThanOrEqual(1);
    expect(overflow.y, 'vertical overflow').toBeLessThanOrEqual(1);

    const recordBox = await record.boundingBox();
    expect(recordBox).toBeTruthy();
    expect(recordBox.width).toBeGreaterThanOrEqual(104);
    expect(recordBox.height).toBeGreaterThanOrEqual(104);
    expectInside(recordBox, width, height);

    for (const tile of await tiles.all()) {
      const box = await tile.boundingBox();
      expect(box).toBeTruthy();
      expect(box.height).toBeGreaterThanOrEqual(64);
      expectInside(box, width, height);
    }

    const buttons = page.locator('button');
    const count = await buttons.count();
    let measured = 0;
    for (let i = 0; i < count; i += 1) {
      const box = await buttons.nth(i).boundingBox();
      if (!box) continue;
      measured += 1;
      expect(box.width, `button ${i} width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `button ${i} height`).toBeGreaterThanOrEqual(44);
      expectInside(box, width, height);
    }
    expect(measured).toBeGreaterThanOrEqual(5);

    await page.screenshot({
      path: `tests/e2e/__output__/layout-${width}x${height}-${testInfo.project.name}.png`,
      animations: 'disabled',
      caret: 'hide',
    });
  });
}

function expectInside(box, width, height) {
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
}
