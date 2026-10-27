// Visual review harness: renders dev preview states across a device matrix and writes
// individual screenshots plus contact sheets.
// Usage: node scripts/screens.mjs [--states a,b] [--devices x,y] [--theme dark|light] [--out dir]
// Requires the dev server (npm run dev) on http://localhost:5173/fliprec/.
import { chromium, webkit } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const DEVICES = {
  se: { width: 375, height: 667, dpr: 2, engine: 'webkit', label: 'iPhone SE 375×667' },
  sesafari: { width: 375, height: 548, dpr: 2, engine: 'webkit', label: 'SE in Safari 375×548' },
  iphone: { width: 390, height: 844, dpr: 3, engine: 'webkit', label: 'iPhone 14 390×844' },
  promax: { width: 430, height: 932, dpr: 3, engine: 'webkit', label: 'Pro Max 430×932' },
  landscape: { width: 844, height: 390, dpr: 3, engine: 'webkit', label: 'Landscape 844×390' },
  android: { width: 412, height: 915, dpr: 2.625, engine: 'chromium', label: 'Pixel 412×915' },
  desktop: { width: 1440, height: 900, dpr: 1, engine: 'chromium', label: 'Desktop 1440×900' },
};

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);

const states = (args.states ?? 'empty,recording,ready,playing-reverse').split(',');
const devices = (args.devices ?? 'iphone').split(',');
const theme = args.theme ?? 'dark';
const out = resolve(args.out ?? 'tests/e2e/__output__/screens');
const base = args.url ?? 'http://localhost:5173/fliprec/';

await mkdir(out, { recursive: true });

const browsers = {};
const shots = [];
for (const key of devices) {
  const device = DEVICES[key];
  if (!device) throw new Error(`Unknown device ${key}`);
  browsers[device.engine] ??= await (device.engine === 'webkit' ? webkit : chromium).launch();
  const context = await browsers[device.engine].newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dpr,
    isMobile: device.engine === 'chromium' && key !== 'desktop',
    hasTouch: key !== 'desktop',
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  await context.addInitScript((t) => {
    try { localStorage.setItem('fliprec:theme', t); } catch {}
  }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  for (const state of states) {
    await page.goto(`${base}?preview=${state}`);
    await page.waitForTimeout(500);
    const file = join(out, `${key}-${state}-${theme}.png`);
    await page.screenshot({ path: file });
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > innerWidth,
      y: document.documentElement.scrollHeight > innerHeight,
    }));
    shots.push({ file, key, state, device, overflow });
  }
  if (errors.length) console.log(`[${key}] console errors:`, [...new Set(errors)].slice(0, 5));
  await context.close();
}

// Contact sheet: one row per device, scaled to a common height.
const sheetBrowser = browsers.chromium ?? (browsers.chromium = await chromium.launch());
const page = await sheetBrowser.newPage({ viewport: { width: 1800, height: 1000 } });
const rowHeight = Number(args.rowh ?? 520);
const rows = [];
for (const key of devices) {
  const items = [];
  for (const s of shots.filter((x) => x.key === key)) {
    const data = (await readFile(s.file)).toString('base64');
    const flag = s.overflow.x || s.overflow.y ? ` ⚠ overflow ${s.overflow.x ? 'X' : ''}${s.overflow.y ? 'Y' : ''}` : '';
    items.push(`<figure><img src="data:image/png;base64,${data}" style="height:${rowHeight}px"><figcaption>${s.state}${flag}</figcaption></figure>`);
  }
  rows.push(`<section><h2>${DEVICES[key].label} · ${theme}</h2><div class="row">${items.join('')}</div></section>`);
}
await page.setContent(`<style>body{margin:0;padding:16px;background:#777;font:13px system-ui;color:#fff}
.row{display:flex;gap:14px;flex-wrap:nowrap}figure{margin:0}img{display:block;border-radius:6px}
h2{font-size:13px;margin:6px 0}</style>${rows.join('')}`);
await page.waitForTimeout(300);
const sheet = join(out, `sheet-${devices.join('_')}-${theme}.png`);
await page.screenshot({ path: sheet, fullPage: true });
console.log(sheet);
for (const b of Object.values(browsers)) await b.close();
