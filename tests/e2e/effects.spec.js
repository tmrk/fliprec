import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { decodeToF32, ffprobeJson, hasFfmpeg } from '../helpers/ffmpeg.js';
import { decodeWavPcm, maxAbsDiff, reverseInterleaved } from '../helpers/pcm.js';
import { bestNormalizedCorrelation, createExportFixture } from '../helpers/signals.js';
import {
  clickDownload,
  importAudio,
  parseClock,
  readTimer,
  trackErrors,
  waitForShareReady,
} from './helpers/app.js';

const fixture = createExportFixture();

test.beforeAll(() => {
  expect(hasFfmpeg(), 'ffmpeg and ffprobe must be on PATH').toBe(true);
});

/** Frequency of one channel of interleaved PCM from upward zero crossings (middle 80 percent). */
function channelFrequency(samples, channels, channel, sampleRate) {
  const frames = samples.length / channels;
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = Math.floor(frames * 0.1) + 1; i < frames * 0.9; i += 1) {
    const a = samples[(i - 1) * channels + channel];
    const b = samples[i * channels + channel];
    if (a < 0 && b >= 0) {
      const t = i - 1 + a / (a - b);
      if (first < 0) first = t;
      else count += 1;
      last = t;
    }
  }
  return count > 0 ? (count * sampleRate) / (last - first) : 0;
}

function m4aDuration(path) {
  const probe = ffprobeJson(path);
  const stream = probe.streams.find((item) => item.codec_type === 'audio');
  expect(probe.format.tags?.major_brand).toBe('M4A ');
  expect(stream.codec_name).toBe('aac');
  expect(stream.profile).toBe('LC');
  return Number(stream.duration ?? probe.format.duration);
}

async function freshExports(page) {
  // Every change invalidates the files first, then rebuilds them after a short pause.
  await expect(page.locator('.fr-header__share')).toHaveAttribute('aria-disabled', 'true');
  await waitForShareReady(page);
}

async function saveAll(page, dir, tag) {
  const sheetButton = (name) => page.getByRole('button', { name });
  await page.getByRole('button', { name: 'More options' }).click();
  await expect(page.locator('#fr-more-sheet')).toBeVisible();
  const m4a = await clickDownload(page, () => sheetButton('Save original M4A').click());
  const m4aPath = join(dir, `${tag}.m4a`);
  await m4a.saveAs(m4aPath);
  const wavs = [];
  for (const variant of ['original', 'reversed']) {
    const download = await clickDownload(page, () => sheetButton(`Save ${variant} WAV`).click());
    const path = join(dir, `${tag}-${variant}.wav`);
    await download.saveAs(path);
    wavs.push(decodeWavPcm(await readFile(path)));
  }
  await page.locator('#fr-more-sheet').getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#fr-more-sheet')).toBeHidden();
  return { m4aPath, original: wavs[0], reversed: wavs[1] };
}

test('Speed and Pitch change what is heard, shared and saved @chromium', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);
  await page.goto('./');

  const speed = page.locator('.fr-fx').first();
  const pitch = page.locator('.fr-fx').last();
  await expect(speed).toHaveAttribute('aria-disabled', 'true');
  await expect(pitch).toHaveAttribute('aria-disabled', 'true');
  await expect(speed).toHaveAccessibleName('Speed, normal');

  await importAudio(page, fixture.bytes, { closeSheet: true });
  await waitForShareReady(page);
  await expect(speed).not.toHaveAttribute('aria-disabled', 'true');

  const dir = await mkdtemp(join(tmpdir(), 'fliprec-fx-'));
  try {
    // Speed 2x: half as long, an octave up.
    await speed.click();
    await expect(speed).toHaveAccessibleName('Speed, fast');
    await expect(speed.locator('.fr-fx__dial')).toHaveText('2×');
    await expect(speed).toHaveClass(/fr-fx--on/);
    await freshExports(page);
    expect(Math.abs(parseClock(await readTimer(page)) - 1.5)).toBeLessThanOrEqual(0.1);
    let saved = await saveAll(page, dir, 'fast');
    expect(Math.abs(m4aDuration(saved.m4aPath) - 1.5)).toBeLessThanOrEqual(0.08);
    let rate = saved.original.sampleRate;
    expect(Math.abs(saved.original.samples.length / 2 / rate - 1.5)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(channelFrequency(saved.original.samples, 2, 1, rate) - 1320)).toBeLessThan(13);
    expect(maxAbsDiff(saved.reversed.samples, reverseInterleaved(saved.original.samples, 2))).toBeLessThanOrEqual(1);

    // Pitch 1/2x on top: still half as long, back at the original pitch.
    await pitch.click();
    await pitch.click();
    await expect(pitch).toHaveAccessibleName('Pitch, low');
    await expect(pitch.locator('.fr-fx__dial')).toHaveText('½×');
    await freshExports(page);
    saved = await saveAll(page, dir, 'fast-low');
    expect(Math.abs(m4aDuration(saved.m4aPath) - 1.5)).toBeLessThanOrEqual(0.08);
    rate = saved.original.sampleRate;
    expect(Math.abs(channelFrequency(saved.original.samples, 2, 1, rate) - 660)).toBeLessThan(7);
    expect(maxAbsDiff(saved.reversed.samples, reverseInterleaved(saved.original.samples, 2))).toBeLessThanOrEqual(1);

    // Back to 1x / 1x: the untouched take again.
    await speed.click();
    await speed.click();
    await pitch.click();
    await expect(speed).toHaveAccessibleName('Speed, normal');
    await expect(pitch).toHaveAccessibleName('Pitch, normal');
    await expect(speed).not.toHaveClass(/fr-fx--on/);
    await freshExports(page);
    expect(Math.abs(parseClock(await readTimer(page)) - 3)).toBeLessThanOrEqual(0.1);
    saved = await saveAll(page, dir, 'normal');
    expect(Math.abs(m4aDuration(saved.m4aPath) - 3)).toBeLessThanOrEqual(0.06);
    const pcm = await decodeToF32(saved.m4aPath, { channels: 2, sampleRate: 48000 });
    expect(bestNormalizedCorrelation(fixture.left, pcm[0])).toBeGreaterThan(0.9);
    expect(bestNormalizedCorrelation(fixture.right, pcm[1])).toBeGreaterThan(0.9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  expect(errors).toEqual([]);
});

test('Speed and Pitch keep playback going @chromium', async ({ page }) => {
  await page.goto('./');
  await importAudio(page, fixture.bytes, { closeSheet: true });
  const play = page.locator('.fr-tile--reverse');
  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.fr-fx').first().click();
  await page.waitForTimeout(300);
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.fr-status')).toHaveText('Playing reversed');
});
