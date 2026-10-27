import { memo, useLayoutEffect, useRef } from 'react';
import { controller, TRANSPORT_EVENT } from '../engine/controller.js';
import { useFrameLoop } from '../hooks/useFrameLoop.js';
import { useStore } from '../hooks/useStore.js';
import { rmsToLevel } from '../audio/level.js';
import { formatTime } from '../lib/format.js';
import './Waveform.css';

const BAR_W = 3;
const GAP = 2;
const PITCH = BAR_W + GAP;

function clamp01(value) {
  if (!(value > 0)) return 0;
  if (value > 1) return 1;
  return value;
}

function barCountFor(width) {
  if (width < BAR_W) return 1;
  return Math.max(1, Math.floor((width + GAP) / PITCH));
}

function bucketPeaks(peaks, count) {
  const out = new Array(count).fill(0);
  const length = peaks ? peaks.length : 0;
  if (!length || !count) return out;
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i * length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * length) / count));
    let max = 0;
    for (let j = start; j < end && j < length; j += 1) {
      if (peaks[j] > max) max = peaks[j];
    }
    out[i] = max;
  }
  return out;
}

function fillRoundBar(ctx, x, y, w, h) {
  const radius = Math.min(w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
  ctx.fill();
}

function readColors() {
  const style = getComputedStyle(document.documentElement);
  const pick = (name) => style.getPropertyValue(name).trim() || 'transparent';
  return {
    rec: pick('--rec'),
    text: pick('--text'),
    text3: pick('--text-3'),
    flip: pick('--flip'),
    play: pick('--play'),
  };
}

const Waveform = memo(function Waveform() {
  const phase = useStore((state) => state.phase);
  const playbackState = useStore((state) => state.playback.state);
  const direction = useStore((state) => state.playback.direction);

  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const colorsRef = useRef(null);
  const levelsRef = useRef([]);
  const smoothRef = useRef(0);
  const lastSampleRef = useRef(0);
  const shownDirRef = useRef(direction);
  const prevDirRef = useRef(null);
  const peakCacheRef = useRef({ dir: '', count: 0, peaks: null, bars: null });
  const sizeRef = useRef({ width: 0, height: 0 });
  const phaseRef = useRef(phase);
  const playRef = useRef(playbackState);
  phaseRef.current = phase;
  playRef.current = playbackState;

  const api = useRef({});
  const seekable = phase === 'ready';
  const looping = phase === 'recording' || playbackState === 'playing';

  api.current.layout = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return null;
    // Size comes from the ResizeObserver; measuring here would force layout every frame.
    if (!sizeRef.current.width) {
      const rect = wrap.getBoundingClientRect();
      sizeRef.current = { width: rect.width, height: rect.height };
    }
    const { width, height } = sizeRef.current;
    if (width < 2 || height < 2) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const bitmapW = Math.max(1, Math.round(width * dpr));
    const bitmapH = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
      canvas.width = bitmapW;
      canvas.height = bitmapH;
    }
    return { width, height, dpr };
  };

  api.current.seed = (count, now) => {
    const history = controller.getLevelHistory(count);
    const next = [];
    let smooth = 0;
    if (history && history.length) {
      for (let i = 0; i < history.length; i += 1) {
        smooth = smooth * 0.6 + rmsToLevel(history[i]) * 0.4;
        next.push(smooth);
      }
    }
    while (next.length < count) next.unshift(0);
    if (next.length > count) next.splice(0, next.length - count);
    levelsRef.current = next;
    smoothRef.current = smooth;
    lastSampleRef.current = now;
  };

  api.current.sample = (now) => {
    if (phaseRef.current !== 'recording') {
      lastSampleRef.current = 0;
      return;
    }
    const count = barCountFor(sizeRef.current.width || 0);
    if (levelsRef.current.length !== count || !lastSampleRef.current) {
      api.current.seed(count, now);
      return;
    }
    if (now - lastSampleRef.current < 50) return;
    lastSampleRef.current = now;
    // getLevel() is already a 0..1 meter level.
    const level = clamp01(controller.getLevel());
    smoothRef.current = smoothRef.current * 0.6 + level * 0.4;
    const levels = levelsRef.current;
    levels.push(smoothRef.current);
    if (levels.length > count) levels.splice(0, levels.length - count);
  };

  api.current.barsFor = (dir, count) => {
    const peaks = controller.getPeaks(dir) || [];
    const cache = peakCacheRef.current;
    if (cache.dir === dir && cache.count === count && cache.peaks === peaks) return cache.bars;
    const bars = bucketPeaks(peaks, count);
    peakCacheRef.current = { dir, count, peaks, bars };
    return bars;
  };

  api.current.updateAria = () => {
    const el = wrapRef.current;
    if (!el || phaseRef.current !== 'ready') return;
    const duration = controller.getDuration();
    const position = controller.getPosition();
    const pct = duration > 0 ? Math.round(clamp01(position / duration) * 100) : 0;
    if (el.getAttribute('aria-valuenow') === String(pct)) return;
    el.setAttribute('aria-valuenow', String(pct));
    el.setAttribute(
      'aria-valuetext',
      `${formatTime(position)} of ${formatTime(duration)}`,
    );
  };

  api.current.draw = () => {
    const laid = api.current.layout();
    const canvas = canvasRef.current;
    if (!laid || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height, dpr } = laid;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const count = barCountFor(width);
    const phaseNow = phaseRef.current;
    const colors = colorsRef.current || readColors();
    colorsRef.current = colors;

    let values;
    let kind;
    if (phaseNow === 'recording') {
      if (levelsRef.current.length !== count || !lastSampleRef.current) {
        api.current.seed(count, performance.now());
      }
      values = levelsRef.current;
      kind = 'live';
    } else if (phaseNow === 'ready' || phaseNow === 'processing') {
      values = api.current.barsFor(shownDirRef.current, count);
      kind = values.some((value) => value > 0) ? 'static' : 'empty';
    } else {
      values = null;
      kind = 'empty';
    }

    const duration = controller.getDuration();
    const position = phaseNow === 'ready' ? controller.getPosition() : 0;
    const progress = duration > 0 ? clamp01(position / duration) : 0;
    const played = shownDirRef.current === 'reverse' ? colors.flip : colors.play;
    const mid = height / 2;
    const total = count * PITCH - GAP;
    let x = Math.max(0, (width - total) / 2);

    ctx.globalAlpha = kind === 'empty' ? 0.6 : 1;
    for (let i = 0; i < count; i += 1) {
      const raw = kind === 'empty' ? 0 : values[i] || 0;
      const amp = Math.sqrt(clamp01(raw));
      const barH = Math.max(2, amp * (height - 2));
      if (kind === 'live') ctx.fillStyle = colors.rec;
      else if (kind === 'static' && phaseNow === 'ready' && (i + 0.5) / count <= progress) {
        ctx.fillStyle = played;
      } else ctx.fillStyle = colors.text3;
      fillRoundBar(ctx, x, mid - barH / 2, BAR_W, barH);
      x += PITCH;
    }
    ctx.globalAlpha = 1;
    api.current.updateAria();
  };

  useLayoutEffect(() => {
    colorsRef.current = readColors();
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const redraw = () => api.current.draw();
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) sizeRef.current = { width: box.width, height: box.height };
      redraw();
    });
    observer.observe(wrap);
    const theme = new MutationObserver(() => {
      colorsRef.current = readColors();
      redraw();
    });
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const onTransport = () => redraw();
    window.addEventListener(TRANSPORT_EVENT, onTransport);
    redraw();
    return () => {
      observer.disconnect();
      theme.disconnect();
      window.removeEventListener(TRANSPORT_EVENT, onTransport);
    };
  }, []);

  useLayoutEffect(() => {
    if (phase !== 'recording') {
      lastSampleRef.current = 0;
      levelsRef.current = [];
    }
    const previous = prevDirRef.current;
    prevDirRef.current = direction;
    const wrap = wrapRef.current;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let midpoint = 0;
    let done = 0;
    if (previous != null && previous !== direction && phase === 'ready' && !reduce) {
      wrap?.classList.add('fr-wave--flip');
      midpoint = window.setTimeout(() => {
        shownDirRef.current = direction;
        api.current.draw();
      }, 120);
      done = window.setTimeout(() => wrap?.classList.remove('fr-wave--flip'), 240);
    } else {
      shownDirRef.current = direction;
      api.current.draw();
    }
    return () => {
      window.clearTimeout(midpoint);
      window.clearTimeout(done);
      wrap?.classList.remove('fr-wave--flip');
    };
  }, [direction, phase, playbackState]);

  useFrameLoop(looping, (now) => {
    api.current.sample(now);
    api.current.draw();
  });

  function fractionFrom(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return 0;
    return clamp01((event.clientX - rect.left) / rect.width);
  }

  function onPointerDown(event) {
    if (!seekable || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    controller.seek(fractionFrom(event));
    api.current.draw();
  }

  function onPointerMove(event) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    controller.seek(fractionFrom(event));
    api.current.draw();
  }

  function onKeyDown(event) {
    if (!seekable) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const duration = controller.getDuration();
    if (!(duration > 0)) return;
    const delta = event.key === 'ArrowRight' ? 0.05 : -0.05;
    controller.seek(clamp01(controller.getPosition() / duration + delta));
    api.current.draw();
  }

  return (
    <div
      ref={wrapRef}
      className="fr-wave"
      role={seekable ? 'slider' : 'img'}
      aria-label={seekable ? 'Playback position' : 'Waveform'}
      aria-valuemin={seekable ? 0 : undefined}
      aria-valuemax={seekable ? 100 : undefined}
      aria-orientation={seekable ? 'horizontal' : undefined}
      tabIndex={seekable ? 0 : undefined}
      onPointerDown={seekable ? onPointerDown : undefined}
      onPointerMove={seekable ? onPointerMove : undefined}
      onKeyDown={seekable ? onKeyDown : undefined}
    >
      <canvas ref={canvasRef} className="fr-wave__canvas" />
    </div>
  );
});

export default Waveform;
