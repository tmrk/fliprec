import { spawn, spawnSync } from 'node:child_process';

/** True when both ffmpeg and ffprobe are on PATH and runnable. */
export function hasFfmpeg() {
  try {
    const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    const ffprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return ffmpeg.status === 0 && ffprobe.status === 0;
  } catch {
    return false;
  }
}

/**
 * `ffprobe -show_format -show_streams -of json`.
 * @param {string} path
 */
export function ffprobeJson(path) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    path,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `ffprobe failed (${result.status})`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Decode to planar Float32 channels.
 * `ffmpeg -i in -f f32le -ac N -ar R pipe:`
 * @param {string} path
 * @param {{ channels: number, sampleRate: number }} options
 * @returns {Promise<Float32Array[]>}
 */
export function decodeToF32(path, { channels, sampleRate }) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v', 'error',
      '-i', path,
      '-f', 'f32le',
      '-ac', String(channels),
      '-ar', String(sampleRate),
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    /** @type {Buffer[]} */
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffmpeg exited ${code}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      if (buf.byteLength % 4 !== 0) {
        reject(new Error('ffmpeg f32le output is not a multiple of 4 bytes'));
        return;
      }
      const interleaved = new Float32Array(buf.byteLength / 4);
      for (let i = 0; i < interleaved.length; i++) {
        interleaved[i] = buf.readFloatLE(i * 4);
      }
      if (interleaved.length % channels !== 0) {
        reject(new Error('Decoded frame count is not divisible by channel count'));
        return;
      }
      const frames = interleaved.length / channels;
      /** @type {Float32Array[]} */
      const planar = [];
      for (let channel = 0; channel < channels; channel++) {
        const samples = new Float32Array(frames);
        for (let frame = 0; frame < frames; frame++) {
          samples[frame] = interleaved[frame * channels + channel];
        }
        planar.push(samples);
      }
      resolve(planar);
    });
  });
}
