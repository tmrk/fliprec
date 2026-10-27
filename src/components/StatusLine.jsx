import { memo, useLayoutEffect, useRef } from 'react';
import { controller } from '../engine/controller.js';
import { useFrameLoop } from '../hooks/useFrameLoop.js';
import { useStore } from '../hooks/useStore.js';
import { formatRemaining } from '../lib/format.js';
import './StatusLine.css';

function statusCopy(phase, playbackState, direction) {
  if (phase === 'requesting') return 'Waiting for microphone...';
  if (phase === 'processing') return 'Processing...';
  if (phase === 'recording') return formatRemaining(controller.getElapsed()) || 'Recording';
  if (playbackState === 'playing') {
    return direction === 'reverse' ? 'Playing reversed' : 'Playing';
  }
  if (playbackState === 'paused') return 'Paused';
  if (phase === 'ready') return 'Ready';
  return 'Tap to record';
}

const StatusLine = memo(function StatusLine() {
  const phase = useStore((state) => state.phase);
  const playbackState = useStore((state) => state.playback.state);
  const direction = useStore((state) => state.playback.direction);
  const textRef = useRef(null);
  const phaseRef = useRef(phase);
  const playRef = useRef(playbackState);
  const dirRef = useRef(direction);
  phaseRef.current = phase;
  playRef.current = playbackState;
  dirRef.current = direction;

  const writeRef = useRef(() => {});
  writeRef.current = () => {
    const el = textRef.current;
    if (!el) return;
    const next = statusCopy(phaseRef.current, playRef.current, dirRef.current);
    if (el.textContent !== next) el.textContent = next;
  };

  useLayoutEffect(() => {
    writeRef.current();
  });

  useFrameLoop(phase === 'recording', () => writeRef.current());

  return (
    <p className="fr-status">
      {phase === 'recording' ? <span className="fr-status__dot" aria-hidden="true" /> : null}
      <span ref={textRef} />
    </p>
  );
});

export default StatusLine;
