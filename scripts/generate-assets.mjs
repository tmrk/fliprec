// Rasterise icons, iOS splash screens and the Open Graph image from the master SVGs.
// Usage: npm run icons
import { chromium } from '@playwright/test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const iconsDir = join(publicDir, 'icons');
const splashDir = join(publicDir, 'splash');
const indexPath = join(root, 'index.html');

// CSS px × device pixel ratio. Filenames use physical pixels so the two 414×896
// devices (dpr 2 and 3) do not overwrite each other. Media queries stay in CSS px.
const DEVICES = [
  [440, 956, 3],
  [430, 932, 3],
  [402, 874, 3],
  [393, 852, 3],
  [390, 844, 3],
  [428, 926, 3],
  [375, 812, 3],
  [414, 896, 3],
  [414, 896, 2],
  [375, 667, 2],
  [320, 568, 2],
];

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function splashFile(w, h, dpr) {
  return `apple-splash-${w * dpr}x${h * dpr}.png`;
}

function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function filterInto(type, src, prev, bpp, out) {
  for (let i = 0; i < src.length; i++) {
    const left = i >= bpp ? src[i - bpp] : 0;
    const up = prev ? prev[i] : 0;
    const ul = prev && i >= bpp ? prev[i - bpp] : 0;
    let pred = 0;
    if (type === 1) pred = left;
    else if (type === 2) pred = up;
    else if (type === 3) pred = (left + up) >> 1;
    else if (type === 4) pred = paeth(left, up, ul);
    out[i] = (src[i] - pred) & 255;
  }
}

function unfilter(type, src, prev, bpp, dest) {
  if (type < 0 || type > 4) throw new Error(`bad png filter ${type}`);
  for (let i = 0; i < src.length; i++) {
    const left = i >= bpp ? dest[i - bpp] : 0;
    const up = prev ? prev[i] : 0;
    const ul = prev && i >= bpp ? prev[i - bpp] : 0;
    let pred = 0;
    if (type === 1) pred = left;
    else if (type === 2) pred = up;
    else if (type === 3) pred = (left + up) >> 1;
    else if (type === 4) pred = paeth(left, up, ul);
    dest[i] = (src[i] + pred) & 255;
  }
}

function scoreRow(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE((crc32(data, crc32(typeBuf)) >>> 0), 8 + data.length);
  return out;
}

function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a png');
  let o = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const idats = [];
  let sawIend = false;
  while (o + 12 <= buf.length) {
    const len = buf.readUInt32BE(o);
    if (o + 12 + len > buf.length) throw new Error('truncated png');
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    const got = buf.readUInt32BE(o + 8 + len);
    const expect = crc32(data, crc32(buf.subarray(o + 4, o + 8))) >>> 0;
    if (got !== expect) throw new Error(`bad crc ${type}`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
    o += 12 + len;
  }
  if (!sawIend || width == null) throw new Error('incomplete png');
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`unsupported png bitDepth=${bitDepth} interlace=${interlace}`);
  }
  const channels = { 2: 3, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported png color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idats));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`png raw length ${raw.length}`);
  }
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const rowAt = y * (stride + 1);
    const src = raw.subarray(rowAt + 1, rowAt + 1 + stride);
    const dest = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);
    unfilter(raw[rowAt], src, prev, channels, dest);
  }
  return { width, height, colorType, channels, pixels };
}

function encodePng(width, height, pixels, channels) {
  const stride = width * channels;
  const filtered = Buffer.alloc(height * (stride + 1));
  const trials = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const src = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    // Solid rows (splash background) collapse to a zero Up-filter.
    if (prev && src.equals(prev)) {
      filtered[at] = 2;
      continue;
    }
    let bestType = 0;
    let bestScore = Infinity;
    for (let type = 0; type < 5; type++) {
      filterInto(type, src, prev, channels, trials[type]);
      const s = scoreRow(trials[type]);
      if (s < bestScore) {
        bestScore = s;
        bestType = type;
      }
    }
    filtered[at] = bestType;
    trials[bestType].copy(filtered, at + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const png = Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const back = decodePng(png);
  if (back.width !== width || back.height !== height || back.channels !== channels || !back.pixels.equals(pixels)) {
    throw new Error(`png round-trip failed ${width}x${height}`);
  }
  return png;
}

function dropAlpha(pixels) {
  const rgb = Buffer.alloc((pixels.length / 4) * 3);
  let clear = 0;
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    const a = pixels[i + 3];
    if (a !== 255) clear += 1;
    const af = a / 255;
    rgb[j] = Math.round(pixels[i] * af + 0x0d * (1 - af));
    rgb[j + 1] = Math.round(pixels[i + 1] * af + 0x0d * (1 - af));
    rgb[j + 2] = Math.round(pixels[i + 2] * af + 0x10 * (1 - af));
  }
  return { rgb, clear };
}

// Recompress. Opaque targets become truecolor (color type 2); splash screens are
// flat #0D0D10 plus a small icon, and apple-touch / maskable must have no alpha.
function optimisePng(png, { opaque }) {
  const decoded = decodePng(png);
  if (!opaque) return encodePng(decoded.width, decoded.height, decoded.pixels, decoded.channels);
  if (decoded.channels === 3) return encodePng(decoded.width, decoded.height, decoded.pixels, 3);
  const { rgb, clear } = dropAlpha(decoded.pixels);
  if (clear !== 0) {
    throw new Error(`${decoded.width}x${decoded.height} opaque render has ${clear} transparent pixels`);
  }
  return encodePng(decoded.width, decoded.height, rgb, 3);
}

function iconHtml(uri, px, background) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${px}px; height: ${px}px; overflow: hidden; background: ${background}; }
  img { width: ${px}px; height: ${px}px; display: block; }
</style>
</head>
<body><img width="${px}" height="${px}" alt="" src="${uri}"></body>
</html>`;
}

function splashHtml(uri, cssW, cssH) {
  // Integer CSS offsets keep the glyph on a device pixel after dpr scaling.
  const left = Math.round((cssW - 96) / 2);
  const top = Math.round((cssH - 96) / 2);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${cssW}px; height: ${cssH}px; overflow: hidden; background: #0D0D10; }
  img { position: absolute; left: ${left}px; top: ${top}px; width: 96px; height: 96px; display: block; }
</style>
</head>
<body><img width="96" height="96" alt="" src="${uri}"></body>
</html>`;
}

// 9:6 is the integer 3:2 pair nearest a 10px bar. Even count so the colour split
// has no centre bar, and the right half is a mirror of the left (a palindrome).
function waveModel() {
  const bar = 9;
  const gap = 6;
  if (bar * 2 !== gap * 3) throw new Error('bar:gap must be 3:2');
  const inner = 1200 - 80 * 2;
  let count = Math.floor((inner + gap) / (bar + gap));
  if (count % 2) count -= 1;
  const heights = new Array(count);
  const half = count / 2;
  for (let i = 0; i < half; i++) {
    const x = (i + 0.5) / count;
    const env = Math.sin(Math.PI * x);
    const lobes = Math.abs(Math.sin(Math.PI * x * 7));
    const h = Math.max(bar, Math.round(8 + env * (10 + lobes * 46)));
    heights[i] = h;
    heights[count - 1 - i] = h;
  }
  const width = count * bar + (count - 1) * gap;
  const left = Math.round((1200 - width) / 2);
  const maxH = Math.max(...heights);
  return { bar, gap, heights, width, left, maxH };
}

function ogHtml(uri, fontCss) {
  const wave = waveModel();
  const bars = wave.heights.map((h, i) => {
    const color = i < wave.heights.length / 2 ? 'rgba(245,244,240,.25)' : 'rgba(165,149,255,.45)';
    return `<span style="height:${h}px;background:${color}"></span>`;
  }).join('');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  ${fontCss}
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #0D0D10; }
  .lockup {
    position: absolute;
    left: 88px;
    top: 205px;
    height: 220px;
    display: flex;
    align-items: center;
    gap: 56px;
  }
  img { width: 220px; height: 220px; display: block; }
  .copy { display: flex; flex-direction: column; justify-content: center; gap: 14px; height: 220px; }
  .mark, .tag { margin: 0; font-family: Nunito, sans-serif; white-space: nowrap; }
  .mark {
    font-weight: 800;
    font-size: 108px;
    line-height: 1;
    letter-spacing: -0.01em;
    color: #F5F4F0;
  }
  .tag {
    font-weight: 600;
    font-size: 40px;
    line-height: 1.15;
    color: rgba(245,244,240,.62);
  }
  .wave {
    position: absolute;
    left: ${wave.left}px;
    bottom: 80px;
    width: ${wave.width}px;
    height: ${wave.maxH}px;
    display: flex;
    align-items: center;
    gap: ${wave.gap}px;
  }
  .wave span { display: block; width: ${wave.bar}px; flex: none; border-radius: 999px; }
</style>
</head>
<body>
  <div class="lockup">
    <img width="220" height="220" alt="" src="${uri}">
    <div class="copy">
      <div class="mark">FlipRec</div>
      <div class="tag">Hear your voice backwards.</div>
    </div>
  </div>
  <div class="wave">${bars}</div>
</body>
</html>`;
}

async function loadNunitoCss() {
  const cssUrl = 'https://fonts.googleapis.com/css2?family=Nunito:wght@600;800&display=swap';
  const cssRes = await fetch(cssUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!cssRes.ok) throw new Error(`Nunito CSS ${cssRes.status}`);
  let css = await cssRes.text();
  const urls = [...new Set([...css.matchAll(/https:\/\/fonts\.gstatic\.com\/[^)'"\s]+/g)].map((m) => m[0]))];
  if (!urls.length) throw new Error('Nunito CSS had no font files');
  await Promise.all(urls.map(async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Nunito font ${res.status}`);
    const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    const type = (res.headers.get('content-type') || 'font/woff2').split(';')[0];
    css = css.split(url).join(`data:${type};base64,${b64}`);
  }));
  return css;
}

async function shoot(page, html, cssW, cssH, { omitBackground = false, prepare = null } = {}) {
  await page.setViewportSize({ width: cssW, height: cssH });
  await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
  if (prepare) await prepare(page);
  else {
    await page.evaluate(async () => {
      const img = document.querySelector('img');
      if (img?.decode) await img.decode();
    });
  }
  return page.screenshot({
    type: 'png',
    omitBackground,
    animations: 'disabled',
    caret: 'hide',
    clip: { x: 0, y: 0, width: cssW, height: cssH },
    timeout: 60_000,
  });
}

async function writePng(file, png) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, png);
}

function splashLinks() {
  return DEVICES.map(([w, h, dpr]) => {
    const media = `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)`;
    const href = `%BASE_URL%splash/${splashFile(w, h, dpr)}`;
    return `    <link rel="apple-touch-startup-image" media="${media}" href="${href}">`;
  }).join('\n');
}

function upsertSplash(html) {
  const block = `    <!-- splash:start -->\n${splashLinks()}\n    <!-- splash:end -->`;
  const re = /[ \t]*<!-- splash:start -->[\s\S]*?<!-- splash:end -->/;
  if (re.test(html)) return html.replace(re, block);
  const anchor = '    <link rel="apple-touch-icon" href="%BASE_URL%icons/apple-touch-icon.png" sizes="180x180" />';
  if (!html.includes(anchor)) throw new Error('index.html is missing the apple-touch-icon link');
  return html.replace(anchor, `${anchor}\n${block}`);
}

function pxAt(decoded, x, y) {
  const i = (y * decoded.width + x) * decoded.channels;
  const p = decoded.pixels;
  const a = decoded.channels === 4 ? p[i + 3] : 255;
  return [p[i], p[i + 1], p[i + 2], a];
}

function assertDarkOpaque(decoded, rel) {
  const corners = [[0, 0], [decoded.width - 1, 0], [0, decoded.height - 1], [decoded.width - 1, decoded.height - 1]];
  for (const [x, y] of corners) {
    const [r, g, b, a] = pxAt(decoded, x, y);
    if (a !== 255 || r > 50 || g > 50 || b > 70) {
      throw new Error(`${rel} corner ${x},${y} is ${r},${g},${b},${a} (want opaque dark tile)`);
    }
  }
}

function assertFlat(decoded, rel) {
  const corners = [[0, 0], [decoded.width - 1, 0], [0, decoded.height - 1], [decoded.width - 1, decoded.height - 1]];
  for (const [x, y] of corners) {
    const [r, g, b, a] = pxAt(decoded, x, y);
    if (a !== 255 || r !== 0x0d || g !== 0x0d || b !== 0x10) {
      throw new Error(`${rel} corner ${x},${y} is ${r},${g},${b},${a} (want #0D0D10)`);
    }
  }
}

function assertClearCorners(decoded, rel) {
  const corners = [[0, 0], [decoded.width - 1, 0], [0, decoded.height - 1], [decoded.width - 1, decoded.height - 1]];
  for (const [x, y] of corners) {
    const alpha = pxAt(decoded, x, y)[3];
    if (alpha !== 0) throw new Error(`${rel} corner ${x},${y} alpha ${alpha} (want transparent)`);
  }
  const mid = pxAt(decoded, decoded.width >> 1, decoded.height >> 1);
  if (mid[3] === 0) throw new Error(`${rel} centre is transparent`);
}

function assertSplashIcon(decoded, rel, cssW, cssH, dpr) {
  const icon = 96 * dpr;
  const left = Math.round((cssW - 96) / 2) * dpr;
  const top = Math.round((cssH - 96) / 2) * dpr;
  // Interior of the coral disc, left of the knocked-out triangle.
  const x = left + icon / 2 - 18 * dpr;
  const y = top + icon / 2;
  const [r, g, b] = pxAt(decoded, x, y);
  if (r < 180 || g > 160 || b > 140) {
    throw new Error(`${rel} icon sample ${x},${y} is ${r},${g},${b} (want coral disc)`);
  }
}

async function verify(entries, html) {
  const iconTags = [
    '<link rel="icon" href="%BASE_URL%icons/favicon.svg" type="image/svg+xml" />',
    '<link rel="icon" href="%BASE_URL%icons/favicon-32.png" type="image/png" sizes="32x32" />',
    '<link rel="icon" href="%BASE_URL%icons/favicon-16.png" type="image/png" sizes="16x16" />',
    '<link rel="apple-touch-icon" href="%BASE_URL%icons/apple-touch-icon.png" sizes="180x180" />',
  ];
  for (const tag of iconTags) {
    if (!html.includes(tag)) throw new Error(`index.html missing ${tag}`);
  }
  const blocks = html.split('<!-- splash:start -->').length - 1;
  if (blocks !== 1 || !html.includes('<!-- splash:end -->')) {
    throw new Error(`expected one splash block, found ${blocks}`);
  }
  for (const [w, h, dpr] of DEVICES) {
    const href = `%BASE_URL%splash/${splashFile(w, h, dpr)}`;
    const media = `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)`;
    if (!html.includes(`media="${media}"`) || !html.includes(`href="${href}"`)) {
      throw new Error(`index.html missing splash link ${w}x${h}@${dpr}`);
    }
  }

  const rows = [];
  for (const entry of entries) {
    const buf = await readFile(entry.file);
    const decoded = decodePng(buf);
    const rel = relative(root, entry.file);
    if (decoded.width !== entry.width || decoded.height !== entry.height) {
      throw new Error(`${rel} IHDR ${decoded.width}x${decoded.height} != ${entry.width}x${entry.height}`);
    }
    if (entry.kind === 'clear') {
      if (decoded.colorType !== 6) throw new Error(`${rel} color type ${decoded.colorType} (want 6)`);
      assertClearCorners(decoded, rel);
    } else if (entry.kind === 'bleed') {
      if (decoded.colorType !== 2) throw new Error(`${rel} color type ${decoded.colorType} (want 2, no alpha)`);
      assertDarkOpaque(decoded, rel);
    } else if (entry.kind === 'flat') {
      if (decoded.colorType !== 2) throw new Error(`${rel} color type ${decoded.colorType} (want 2, no alpha)`);
      assertFlat(decoded, rel);
      if (entry.splash) assertSplashIcon(decoded, rel, entry.splash.w, entry.splash.h, entry.splash.dpr);
    }
    rows.push({
      file: rel,
      size: `${decoded.width}x${decoded.height}`,
      bytes: buf.length,
    });
  }
  const fileW = Math.max(...rows.map((r) => r.file.length), 4);
  const sizeW = Math.max(...rows.map((r) => r.size.length), 4);
  const bytesW = Math.max(...rows.map((r) => String(r.bytes).length), 5);
  console.log(`${'file'.padEnd(fileW)}  ${'size'.padEnd(sizeW)}  ${'bytes'.padStart(bytesW)}`);
  for (const row of rows) {
    console.log(`${row.file.padEnd(fileW)}  ${row.size.padEnd(sizeW)}  ${String(row.bytes).padStart(bytesW)}`);
  }
}

async function main() {
  const [full, rounded, small, fontCss] = await Promise.all([
    readFile(join(iconsDir, 'fliprec.svg')),
    readFile(join(iconsDir, 'favicon.svg')),
    readFile(join(iconsDir, 'fliprec-small.svg')),
    loadNunitoCss(),
  ]);
  const fullUri = svgDataUri(full);
  const roundedUri = svgDataUri(rounded);
  const smallUri = svgDataUri(small);

  const browser = await chromium.launch({
    headless: true,
    timeout: 60_000,
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--disable-lcd-text'],
  });
  const entries = [];
  try {
    const ctx = await browser.newContext({
      viewport: { width: 64, height: 64 },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();

    const icons = [
      { name: 'favicon-16.png', svg: smallUri, px: 16, opaque: false, kind: 'clear' },
      { name: 'favicon-32.png', svg: smallUri, px: 32, opaque: false, kind: 'clear' },
      { name: 'apple-touch-icon.png', svg: fullUri, px: 180, opaque: true, kind: 'bleed', background: '#0D0D10' },
      { name: 'icon-192.png', svg: roundedUri, px: 192, opaque: false, kind: 'clear' },
      { name: 'icon-512.png', svg: roundedUri, px: 512, opaque: false, kind: 'clear' },
      { name: 'icon-maskable-512.png', svg: fullUri, px: 512, opaque: true, kind: 'bleed', background: '#0D0D10' },
    ];
    for (const icon of icons) {
      const shot = await shoot(
        page,
        iconHtml(icon.svg, icon.px, icon.opaque ? icon.background : 'transparent'),
        icon.px,
        icon.px,
        { omitBackground: !icon.opaque },
      );
      const file = join(iconsDir, icon.name);
      await writePng(file, optimisePng(shot, { opaque: icon.opaque }));
      entries.push({ file, width: icon.px, height: icon.px, kind: icon.kind });
    }

    const ogShot = await shoot(page, ogHtml(roundedUri, fontCss), 1200, 630, {
      prepare: async (p) => {
        const layout = await p.evaluate(async () => {
          await document.fonts.ready;
          const specs = ['800 108px Nunito', '600 40px Nunito'];
          await Promise.all(specs.map((spec) => document.fonts.load(spec)));
          await document.fonts.ready;
          for (const spec of specs) {
            if (!document.fonts.check(spec)) {
              const faces = [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`).join(' | ');
              throw new Error(`font not ready: ${spec} [${faces}]`);
            }
          }
          const box = (sel) => {
            const r = document.querySelector(sel).getBoundingClientRect();
            return { l: r.left, t: r.top, r: r.right, b: r.bottom };
          };
          const mark = getComputedStyle(document.querySelector('.mark'));
          const tag = getComputedStyle(document.querySelector('.tag'));
          return {
            icon: box('img'),
            mark: box('.mark'),
            tag: box('.tag'),
            wave: box('.wave'),
            w: 1200,
            h: 630,
            markFamily: mark.fontFamily,
            markWeight: mark.fontWeight,
            markSize: mark.fontSize,
            markSpacing: mark.letterSpacing,
            tagWeight: tag.fontWeight,
            tagSize: tag.fontSize,
          };
        });
        if (!/Nunito/.test(layout.markFamily)) throw new Error(`wordmark font ${layout.markFamily}`);
        if (layout.markWeight !== '800' || layout.markSize !== '108px') {
          throw new Error(`wordmark style ${layout.markWeight} ${layout.markSize}`);
        }
        if (layout.tagWeight !== '600' || layout.tagSize !== '40px') {
          throw new Error(`tagline style ${layout.tagWeight} ${layout.tagSize}`);
        }
        // -0.01em at 108px is -1.08px.
        const spacing = Number.parseFloat(layout.markSpacing);
        if (Math.abs(spacing + 1.08) > 0.05) throw new Error(`letter-spacing ${layout.markSpacing}`);
        for (const [name, b] of Object.entries(layout)) {
          if (!b || typeof b !== 'object' || b.l == null) continue;
          if (b.l < 80 - 0.5 || b.t < 80 - 0.5 || b.r > layout.w - 80 + 0.5 || b.b > layout.h - 80 + 0.5) {
            throw new Error(`OG ${name} outside the 80px margin ${JSON.stringify(b)}`);
          }
        }
      },
    });
    const ogFile = join(publicDir, 'og-image.png');
    await writePng(ogFile, optimisePng(ogShot, { opaque: true }));
    entries.push({ file: ogFile, width: 1200, height: 630, kind: 'flat' });
    await ctx.close();

    for (const dpr of [3, 2]) {
      const splashCtx = await browser.newContext({
        viewport: { width: 320, height: 480 },
        deviceScaleFactor: dpr,
      });
      const splashPage = await splashCtx.newPage();
      for (const [w, h, deviceDpr] of DEVICES) {
        if (deviceDpr !== dpr) continue;
        const shot = await shoot(splashPage, splashHtml(roundedUri, w, h), w, h);
        const name = splashFile(w, h, dpr);
        const file = join(splashDir, name);
        await writePng(file, optimisePng(shot, { opaque: true }));
        entries.push({
          file,
          width: w * dpr,
          height: h * dpr,
          kind: 'flat',
          splash: { w, h, dpr },
        });
      }
      await splashCtx.close();
    }
  } finally {
    await browser.close();
  }

  const html = upsertSplash(await readFile(indexPath, 'utf8'));
  const previous = await readFile(indexPath, 'utf8');
  if (html !== previous) await writeFile(indexPath, html);

  try {
    await stat(join(publicDir, 'robots.txt'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await writeFile(join(publicDir, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  }

  await verify(entries, html);
}

await main();
