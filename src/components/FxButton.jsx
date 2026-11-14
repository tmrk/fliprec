import { memo } from 'react';
import { formatStep } from '../audio/effect.js';
import { controller } from '../engine/controller.js';
import { useStore } from '../hooks/useStore.js';
import { pressHandlers } from '../lib/pressable.js';
import './FxButton.css';

const LABELS = { speed: 'Speed', pitch: 'Pitch' };
const WORDS = {
  speed: { 1: 'normal', 2: 'fast', 0.5: 'slow' },
  pitch: { 1: 'normal', 2: 'high', 0.5: 'low' },
};

const FxButton = memo(function FxButton({ kind }) {
  const key = kind === 'pitch' ? 'pitch' : 'speed';
  const enabled = useStore((state) => state.phase === 'ready');
  const value = useStore((state) => state.effect?.[key] ?? 1);
  const label = LABELS[key];
  const word = WORDS[key][value] ?? 'normal';

  function onClick() {
    if (!enabled) return;
    controller.cycleEffect(key);
  }

  const className = value !== 1 ? 'fr-fx fr-press fr-fx--on' : 'fr-fx fr-press';

  return (
    <button
      type="button"
      className={className}
      {...pressHandlers}
      aria-disabled={enabled ? undefined : true}
      aria-label={`${label}, ${word}`}
      onClick={onClick}
    >
      <span className="fr-fx__dial" aria-hidden="true">{formatStep(value)}</span>
      <span className="fr-fx__label" aria-hidden="true">{label}</span>
    </button>
  );
});

export default FxButton;
