import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { controller, TRANSPORT_EVENT } from '../engine/controller.js';
import { useFrameLoop } from '../hooks/useFrameLoop.js';
import { useStore } from '../hooks/useStore.js';
import { splitTime } from '../lib/format.js';
import './Timer.css';

function readSeconds(phase, playbackState) {
  if (phase === 'recording' || phase === 'processing') return controller.getElapsed();
  if (phase === 'requesting') return 0;
  if (playbackState === 'playing' || playbackState === 'paused') return controller.getPosition();
  const duration = controller.getDuration();
  return duration > 0 ? duration : 0;
}

const Timer = memo(function Timer() {
  const phase = useStore((state) => state.phase);
  const playbackState = useStore((state) => state.playback.state);
  const rootRef = useRef(null);
  const mainRef = useRef(null);
  const tenthRef = useRef(null);
  const lastSecondRef = useRef('');
  const phaseRef = useRef(phase);
  const playRef = useRef(playbackState);
  phaseRef.current = phase;
  playRef.current = playbackState;

  const writeRef = useRef(() => {});
  writeRef.current = () => {
    const parts = splitTime(readSeconds(phaseRef.current, playRef.current));
    if (mainRef.current && mainRef.current.textContent !== parts.main) {
      mainRef.current.textContent = parts.main;
    }
    if (tenthRef.current && tenthRef.current.textContent !== parts.tenths) {
      tenthRef.current.textContent = parts.tenths;
    }
    if (rootRef.current && lastSecondRef.current !== parts.main) {
      rootRef.current.setAttribute('aria-label', parts.main + parts.tenths);
      lastSecondRef.current = parts.main;
    }
  };

  useLayoutEffect(() => {
    writeRef.current();
  });

  useFrameLoop(phase === 'recording' || playbackState === 'playing', () => writeRef.current());

  useEffect(() => {
    const onTransport = () => writeRef.current();
    window.addEventListener(TRANSPORT_EVENT, onTransport);
    return () => window.removeEventListener(TRANSPORT_EVENT, onTransport);
  }, []);

  return (
    <div className="fr-timer" role="timer" aria-live="off" aria-label="0:00.0" ref={rootRef}>
      <span ref={mainRef} className="fr-timer__main" />
      <span ref={tenthRef} className="fr-timer__t" />
    </div>
  );
});

export default Timer;
