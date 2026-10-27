import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const DESCRIPTION = 'Record your voice and play it backwards instantly. Share or download real M4A audio. Free, private and works offline. No sign-up, nothing uploaded.';

export const pwaOptions = {
  registerType: 'autoUpdate',
  injectRegister: false,
  scope: '/fliprec/',
  includeAssets: [
    'icons/favicon.svg',
    'icons/favicon-16.png',
    'icons/favicon-32.png',
    'icons/apple-touch-icon.png',
    'robots.txt',
  ],
  manifest: {
    id: './',
    name: 'FlipRec',
    short_name: 'FlipRec',
    description: DESCRIPTION,
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0D0D10',
    theme_color: '#0D0D10',
    lang: 'en',
    categories: ['music', 'utilities', 'entertainment'],
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,png,wasm,webmanifest}'],
    globIgnores: ['splash/**', 'og-image.png'],
    maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
    navigateFallback: 'index.html',
    cleanupOutdatedCaches: true,
    clientsClaim: true,
    skipWaiting: true,
    // Recordings are blob: URLs. Precache the app shell only; no runtime routes.
    runtimeCaching: [],
  },
};

export default defineConfig({
  base: '/fliprec/',
  plugins: [react(), VitePWA(pwaOptions)],
  worker: { format: 'es' },
  build: {
    target: ['es2022', 'safari15'],
  },
  server: {
    host: true,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.js'],
  },
});
