import { Pause, Play } from 'lucide-react';
import { memo } from 'react';
import { controller } from '../engine/controller.js';
import { useStore } from '../hooks/useStore.js';
import { pressHandlers } from '../lib/pressable.js';
import './PlayTile.css';

const PlayTile = memo(function PlayTile({ direction }) {
  const phase = useStore((state) => state.phase);
  const playbackState = useStore((state) => state.playback.state);
  const playbackDirection = useStore((state) => state.playback.direction);
  const enabled = phase === 'ready';
  const active = enabled && playbackDirection === direction;
  const playing = active && playbackState === 'playing';
  const paused = active && playbackState === 'paused';
  const Icon = playing ? Pause : Play;
  const mirror = direction === 'reverse' && !playing;
  const spoken = direction === 'reverse' ? 'reversed' : 'forward';
  const label = direction === 'reverse' ? 'Reverse' : 'Forward';

  function onClick() {
    if (!enabled) return;
    controller.togglePlay(direction);
  }

  const className = [
    'fr-tile',
    'fr-press',
    direction === 'reverse' ? 'fr-tile--reverse' : 'fr-tile--forward',
    playing ? 'fr-tile--playing' : '',
    paused ? 'fr-tile--paused' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      {...pressHandlers}
      aria-disabled={enabled ? undefined : true}
      aria-pressed={playing}
      aria-label={playing ? `Pause ${spoken}` : `Play ${spoken}`}
      onClick={onClick}
    >
      <span className={mirror ? 'fr-tile__icon fr-tile__icon--mirror' : 'fr-tile__icon'}>
        <Icon
          size={34}
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
