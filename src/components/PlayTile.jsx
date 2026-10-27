import { Pause, Play } from 'lucide-react';
import { memo, useLayoutEffect, useRef } from 'react';
import { controller } from '../engine/controller.js';
import { useFrameLoop } from '../hooks/useFrameLoop.js';
import { useStore } from '../hooks/useStore.js';
import * as haptics from '../lib/haptics.js';
import { pressHandlers } from '../lib/pressable.js';
import './PlayTile.css';

function clamp01(value) {
  if (!(value > 0)) return 0;
  if (value > 1) return 1;
  return value;
}

const PlayTile = memo(function PlayTile({ direction }) {
  const phase = useStore((state) => state.phase);
  const playbackState = useStore((state) => state.playback.state);
  const playbackDirection = useStore((state) => state.playback.direction);
  const enabled = phase === 'ready';
  const active = enabled && playbackDirection === direction;
  const playing = active && playbackState === 'playing';
  const Icon = playing ? Pause : Play;
  const mirror = direction === 'reverse' && !playing;
  const label = direction === 'reverse' ? 'Reverse' : 'Play';
  const suffix = direction === 'reverse' ? ' reversed' : '';
  const rootRef = useRef(null);

  useFrameLoop(playing, () => {
    const el = rootRef.current;
    if (!el) return;
    const duration = controller.getDuration();
    const next = duration > 0 ? clamp01(controller.getPosition() / duration) : 0;
    el.style.setProperty('--p', String(next));
  });

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (!active || playbackState === 'stopped') {
      el.style.setProperty('--p', '0');
      return;
    }
    if (playbackState === 'paused') {
      const duration = controller.getDuration();
      const next = duration > 0 ? clamp01(controller.getPosition() / duration) : 0;
      el.style.setProperty('--p', String(next));
    }
  }, [active, playbackState]);

  function onClick() {
    if (!enabled) return;
    haptics.tap();
    controller.togglePlay(direction);
  }

  const className = [
    'fr-tile',
    'fr-press',
    direction === 'reverse' ? 'fr-tile--reverse' : 'fr-tile--forward',
    playing ? 'fr-tile--playing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={rootRef}
      type="button"
      className={className}
      {...pressHandlers}
      aria-disabled={enabled ? undefined : true}
      aria-pressed={playing}
      aria-label={playing ? `Pause${suffix}` : `Play${suffix}`}
      onClick={onClick}
    >
      <span className={mirror ? 'fr-tile__icon fr-tile__icon--mirror' : 'fr-tile__icon'}>
        <Icon
          size={36}
          strokeWidth={2}
          strokeLinejoin="round"
          fill="currentColor"
          aria-hidden="true"
        />
      </span>
      <span className="fr-tile__label">{label}</span>
    </button>
  );
});

export default PlayTile;
