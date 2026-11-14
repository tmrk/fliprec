import { memo, useState } from 'react';
import { controller } from '../engine/controller.js';
import { useStore } from '../hooks/useStore.js';
import { pressHandlers } from '../lib/pressable.js';
import './FxButton.css';

const KINDS = {
  speed: { label: 'Speed', up: 'Fast', down: 'Slow' },
  pitch: { label: 'Pitch', up: 'High', down: 'Low' },
};

function sideOf(value) {
  if (value === 2) return 'up';
  if (value === 0.5) return 'down';
  return 'off';
}

/**
 * A two-way rocker: the top half makes it faster or higher, the bottom half slower or lower.
 * Tapping the lit half again returns to normal.
 */
const FxButton = memo(function FxButton({ kind }) {
  const key = kind === 'pitch' ? 'pitch' : 'speed';
  const copy = KINDS[key];
  const enabled = useStore((state) => state.phase === 'ready');
  const value = useStore((state) => state.effect?.[key] ?? 1);
  const side = sideOf(value);
  // The thumb fades out where it was, appears in place when turned on, and only slides when
  // switching straight from one half to the other.
  const [seen, setSeen] = useState(() => ({
    side,
    last: side === 'off' ? 'up' : side,
    entering: false,
  }));
  if (seen.side !== side) {
    setSeen({
      side,
      last: side === 'off' ? seen.last : side,
      entering: seen.side === 'off',
    });
  }
  const entering = seen.side === side && seen.entering;
  const shownSide = side === 'off' ? seen.last : side;

  let className = 'fr-fx';
  if (side !== 'off') className += ' fr-fx--on';
  if (entering) className += ' fr-fx--enter';

  function pick(target) {
    if (!enabled) return;
    const step = target === 'up' ? 2 : 0.5;
    controller.setEffect(key, value === step ? 1 : step);
  }

  const disabled = enabled ? undefined : true;

  return (
    <div
      className={className}
      role="group"
      aria-label={copy.label}
      data-side={shownSide}
      data-disabled={enabled ? undefined : ''}
    >
      <div className="fr-fx__rocker">
        <button
          type="button"
          className="fr-fx__half fr-fx__half--up fr-press"
          {...pressHandlers}
          aria-pressed={side === 'up'}
          aria-disabled={disabled}
          onClick={() => pick('up')}
        >
          {copy.up}
        </button>
        <button
          type="button"
          className="fr-fx__half fr-fx__half--down fr-press"
          {...pressHandlers}
          aria-pressed={side === 'down'}
          aria-disabled={disabled}
          onClick={() => pick('down')}
        >
          {copy.down}
        </button>
        <span className="fr-fx__thumb" aria-hidden="true" />
      </div>
      <span className="fr-fx__label" aria-hidden="true">{copy.label}</span>
    </div>
  );
});

export default FxButton;
