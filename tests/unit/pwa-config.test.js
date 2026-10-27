import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config, { pwaOptions } from '../../vite.config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function pngSize(file) {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(buf.toString('ascii', 12, 16)).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('pwa config', () => {
  it('serves the app and the service worker under /fliprec/', () => {
    expect(config.base).toBe('/fliprec/');
    expect(pwaOptions.scope).toBe('/fliprec/');
    expect(pwaOptions.registerType).toBe('autoUpdate');
    expect(pwaOptions.injectRegister).toBe(false);
    const plugins = config.plugins.flat(Infinity);
    expect(plugins.some((plugin) => plugin && plugin.name === 'vite-plugin-pwa')).toBe(true);
  });

  it('declares the install manifest and precaches the shell only', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const meta = html.match(/name="description"\s+content="([^"]+)"/);
    expect(meta).not.toBeNull();

    expect(pwaOptions.manifest).toMatchObject({
      id: './',
      name: 'FlipRec',
      short_name: 'FlipRec',
      description: meta[1],
      start_url: './',
      scope: './',
      display: 'standalone',
      orientation: 'any',
      background_color: '#0D0D10',
      theme_color: '#0D0D10',
      lang: 'en',
      categories: ['music', 'utilities', 'entertainment'],
    });
    expect(pwaOptions.manifest.icons).toEqual([
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
    expect(pwaOptions.includeAssets).toEqual([
      'icons/favicon.svg',
      'icons/favicon-16.png',
      'icons/favicon-32.png',
      'icons/apple-touch-icon.png',
      'robots.txt',
    ]);
    expect(pwaOptions.workbox).toMatchObject({
      globPatterns: ['**/*.{js,css,html,svg,png,wasm,webmanifest}'],
      globIgnores: ['splash/**', 'og-image.png'],
      maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      navigateFallback: 'index.html',
      cleanupOutdatedCaches: true,
      clientsClaim: true,
      skipWaiting: true,
      runtimeCaching: [],
    });
  });

  it('points the manifest and index.html at real icons with matching PNG dimensions', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const links = [...html.matchAll(/<link\b[^>]*>/g)].map((match) => match[0]);
    const iconLinks = links.filter((link) => /href="(?:%BASE_URL%)?icons\//.test(link));
    expect(iconLinks.length).toBeGreaterThanOrEqual(4);

    for (const link of iconLinks) {
      const href = link.match(/href="(?:%BASE_URL%)?(icons\/[^"]+)"/);
      expect(href).not.toBeNull();
      const file = join(root, 'public', href[1]);
      expect(existsSync(file), href[1]).toBe(true);
      const sizes = link.match(/sizes="(\d+)x(\d+)"/);
      if (sizes && href[1].endsWith('.png')) {
        expect(pngSize(file)).toEqual({
          width: Number(sizes[1]),
          height: Number(sizes[2]),
        });
      }
    }

    for (const icon of pwaOptions.manifest.icons) {
      const file = join(root, 'public', icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const [width, height] = icon.sizes.split('x').map(Number);
      expect(pngSize(file)).toEqual({ width, height });
    }

    for (const asset of pwaOptions.includeAssets) {
      expect(existsSync(join(root, 'public', asset)), asset).toBe(true);
    }
  });
});
