import { memo, useEffect, useRef, useState } from 'react';
import { controller } from '../engine/controller.js';
import { useStore } from '../hooks/useStore.js';
import { formatSpokenSeconds } from '../lib/format.js';
import './LiveRegion.css';

const SPEED_WORDS = { 1: 'normal', 2: 'fast', 0.5: 'slow' };
const PITCH_WORDS = { 1: 'normal', 2: 'high', 0.5: 'low' };

const LiveRegion = memo(function LiveRegion() {
  const phase = useStore((state) => state.phase);
  const playbackState = useStore((state) => state.playback.state);
  const direction = useStore((state) => state.playback.direction);
  const toast = useStore((state) => state.toast);
  const speed = useStore((state) => state.effect?.speed ?? 1);
  const pitch = useStore((state) => state.effect?.pitch ?? 1);
  const [message, setMessage] = useState('');
  const prevRef = useRef(null);

  useEffect(() => {
    const prev = prevRef.current;
    const parts = [];
    if (prev) {
      if (prev.phase !== 'requesting' && phase === 'requesting') parts.push('Starting microphone');
      if (prev.phase !== 'recording' && phase === 'recording') parts.push('Recording started');
      if (prev.phase === 'recording' && phase !== 'recording') {
        const seconds = controller.getDuration() || controller.getElapsed();
        parts.push(`Recording stopped, ${formatSpokenSeconds(seconds)}`);
      }
      const started =
        playbackState === 'playing' &&
        (prev.playbackState !== 'playing' || prev.direction !== direction);
      if (started) {
        parts.push(direction === 'reverse' ? 'Playing reversed' : 'Playing');
      }
      if (playbackState === 'paused' && prev.playbackState !== 'paused') parts.push('Paused');
      if (speed !== prev.speed) parts.push(`Speed ${SPEED_WORDS[speed] ?? 'normal'}`);
      if (pitch !== prev.pitch) parts.push(`Pitch ${PITCH_WORDS[pitch] ?? 'normal'}`);
      if (toast && toast.id !== prev.toastId && toast.message) parts.push(toast.message);
    } else if (toast?.message) {
      parts.push(toast.message);
    }

    prevRef.current = {
      phase,
      playbackState,
      direction,
      toastId: toast ? toast.id : null,
      speed,
      pitch,
    };
    if (parts.length) setMessage(parts.join('. '));
  }, [phase, playbackState, direction, toast, speed, pitch]);

  return (
    <div className="fr-live" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
});

export default LiveRegion;
