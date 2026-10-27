import { defineConfig, devices } from '@playwright/test';

const mediaArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173/fliprec/',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: mediaArgs },
        permissions: ['microphone'],
      },
    },
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Pixel 7'],
        launchOptions: { args: mediaArgs },
        permissions: ['microphone'],
      },
    },
    {
      // WebKit has no fake microphone. Mic, export, share, and keyboard specs
      // are tagged @chromium and skipped here.
      name: 'webkit-iphone',
      grepInvert: /@chromium/,
      use: {
        ...devices['iPhone 14'],
      },
    },
  ],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/fliprec/',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
