import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { decodeToF32, ffprobeJson, hasFfmpeg } from '../helpers/ffmpeg.js';
import { decodeWavPcm, maxAbsDiff, reverseInterleaved } from '../helpers/pcm.js';
import {
  bestNormalizedCorrelation,
  createExportFixture,
  reverseSamples,
} from '../helpers/signals.js';
import {
  M4A_FILENAME,
  clickDownload,
  importAudio,
  waitForShareReady,
} from './helpers/app.js';

const fixture = createExportFixture();

test.beforeAll(() => {
  expect(hasFfmpeg(), 'ffmpeg and ffprobe must be on PATH').toBe(true);
});

for (const mode of ['native', 'wasm']) {
  test(`exports M4A and a bit-exact reversed WAV (${mode}) @chromium`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const query = mode === 'wasm' ? '?aac=wasm' : '';
    await page.goto(`./${query}`);
    await importAudio(page, fixture.bytes);

    await waitForShareReady(page);
    const reversedM4a = page.getByRole('button', { name: 'Save reversed M4A' });
    const originalM4a = page.getByRole('button', { name: 'Save original M4A' });
    await expect(reversedM4a).not.toHaveAttribute('aria-disabled', 'true');

    const dir = await mkdtemp(join(tmpdir(), 'fliprec-e2e-'));
    try {
      const reversedDownload = await clickDownload(page, () => reversedM4a.click());
      expect(reversedDownload.suggestedFilename()).toMatch(/^fliprec-reversed-\d{8}-\d{6}\.m4a$/);
      expect(reversedDownload.suggestedFilename()).toMatch(M4A_FILENAME);
      const reversedPath = join(dir, 'reversed.m4a');
      await reversedDownload.saveAs(reversedPath);

      await expect(originalM4a).not.toHaveAttribute('aria-disabled', 'true', { timeout: 45_000 });
      const originalDownload = await clickDownload(page, () => originalM4a.click());
      expect(originalDownload.suggestedFilename()).toMatch(/^fliprec-original-\d{8}-\d{6}\.m4a$/);
      const originalPath = join(dir, 'original.m4a');
      await originalDownload.saveAs(originalPath);

      const originalProbe = assertM4a(ffprobeJson(originalPath), originalDownload.suggestedFilename(), testInfo);
      assertM4a(ffprobeJson(reversedPath), reversedDownload.suggestedFilename(), testInfo);
      expect(originalProbe.channels).toBe(2);

      const originalPcm = await decodeToF32(originalPath, { channels: 2, sampleRate: 48000 });
      const reversedPcm = await decodeToF32(reversedPath, { channels: 2, sampleRate: 48000 });
      const reversedLeft = reverseSamples(fixture.left);

      const originalLeft = bestNormalizedCorrelation(fixture.left, originalPcm[0]);
      const reversedMatch = bestNormalizedCorrelation(reversedLeft, reversedPcm[0]);
      const reversedForward = bestNormalizedCorrelation(fixture.left, reversedPcm[0]);
      const originalRight = bestNormalizedCorrelation(fixture.right, originalPcm[1]);
      const reversedRight = bestNormalizedCorrelation(fixture.right, reversedPcm[1]);

      expect(originalLeft, `original L vs chirp ${originalLeft}`).toBeGreaterThan(0.9);
      expect(reversedMatch, `reversed L vs reversed chirp ${reversedMatch}`).toBeGreaterThan(0.9);
      expect(reversedForward, `reversed L vs forward chirp ${reversedForward}`).toBeLessThan(0.5);
      expect(originalRight, `original R vs sine ${originalRight}`).toBeGreaterThan(0.9);
      expect(reversedRight, `reversed R vs sine ${reversedRight}`).toBeGreaterThan(0.9);
      expect(bestNormalizedCorrelation(fixture.right, originalPcm[0]), 'L is not the sine').toBeLessThan(0.5);
      expect(bestNormalizedCorrelation(fixture.left, originalPcm[1]), 'R is not the chirp').toBeLessThan(0.5);

      const reversedWav = await clickDownload(page, () => page.getByRole('button', { name: 'Save reversed WAV' }).click());
      const originalWav = await clickDownload(page, () => page.getByRole('button', { name: 'Save original WAV' }).click());
      expect(reversedWav.suggestedFilename()).toMatch(/^fliprec-reversed-\d{8}-\d{6}\.wav$/);
      expect(originalWav.suggestedFilename()).toMatch(/^fliprec-original-\d{8}-\d{6}\.wav$/);

      const reversedWavPath = join(dir, 'reversed.wav');
      const originalWavPath = join(dir, 'original.wav');
      await reversedWav.saveAs(reversedWavPath);
      await originalWav.saveAs(originalWavPath);

      const decodedOriginal = decodeWavPcm(await readFile(originalWavPath));
      const decodedReversed = decodeWavPcm(await readFile(reversedWavPath));
      expect(decodedOriginal.channels).toBe(2);
      expect(decodedReversed.channels).toBe(2);
      // Exports use the AudioContext rate: 48 kHz on most devices, 44.1 kHz on CI runners.
      expect([44100, 48000]).toContain(decodedOriginal.sampleRate);
      expect(decodedReversed.sampleRate).toBe(decodedOriginal.sampleRate);
      const wavSeconds = decodedOriginal.samples.length / decodedOriginal.channels / decodedOriginal.sampleRate;
      expect(Math.abs(wavSeconds - 3)).toBeLessThanOrEqual(0.01);
      const reversedFromOriginal = reverseInterleaved(decodedOriginal.samples, decodedOriginal.channels);
      const diff = maxAbsDiff(decodedReversed.samples, reversedFromOriginal);
      expect(diff, `reversed WAV is ${diff} LSB from the reversed original PCM`).toBeLessThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

/**
 * @param {ReturnType<typeof ffprobeJson>} probe
 * @param {string} filename
 * @param {import('@playwright/test').TestInfo} testInfo
 */
function assertM4a(probe, filename, testInfo) {
  const stream = probe.streams.find((item) => item.codec_type === 'audio');
  expect(stream, 'audio stream').toBeTruthy();
  const brand = probe.format.tags?.major_brand;
  const duration = Number(stream.duration ?? probe.format.duration);
  const line = `ffprobe ${filename}: major_brand=${JSON.stringify(brand)} codec=${stream.codec_name} profile=${stream.profile} channels=${stream.channels} duration=${duration.toFixed(3)}`;
  console.log(line);
  testInfo.annotations.push({ type: 'ffprobe', description: line });

  expect(brand).toBe('M4A ');
  expect(stream.codec_name).toBe('aac');
  expect(stream.profile).toBe('LC');
  expect(Number(stream.channels)).toBe(2);
  expect(Math.abs(duration - 3)).toBeLessThanOrEqual(0.06);
  return { channels: Number(stream.channels), duration, line };
}
