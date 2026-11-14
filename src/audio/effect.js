/**
 * Speed and pitch values shared by the UI and the engine (tiny, no DSP).
 * Speed works like tape: 2x is twice as fast and an octave higher. Pitch then moves that
 * result up or down an octave without changing its length.
 */

/** Tap order for both controls. */
export const FX_STEPS = Object.freeze([1, 2, 0.5]);

export const NEUTRAL_EFFECT = Object.freeze({ speed: 1, pitch: 1 });

function step(value) {
  return value === 2 || value === 0.5 ? value : 1;
}

export function normalizeEffect(effect) {
  return { speed: step(effect?.speed), pitch: step(effect?.pitch) };
}

export function isNeutralEffect(effect) {
  const { speed, pitch } = normalizeEffect(effect);
  return speed === 1 && pitch === 1;
}

/** 1, then 2, then 1/2, then back to 1. */
export function nextStep(value) {
  const index = FX_STEPS.indexOf(step(value));
  return FX_STEPS[(index + 1) % FX_STEPS.length];
}

export function formatStep(value) {
  const v = step(value);
  return v === 0.5 ? '½×' : `${v}×`;
}

/** Output length in samples for an input of `length` samples. */
export function effectLength(length, effect) {
  return Math.round(length / normalizeEffect(effect).speed);
}
