import { memo, useLayoutEffect, useRef } from 'react';
import { controller } from '../engine/controller.js';
import { useFrameLoop } from '../hooks/useFrameLoop.js';
import { useStore } from '../hooks/useStore.js';
import { pressHandlers } from '../lib/pressable.js';
import './RecordButton.css';

function clamp01(value) {
  if (!(value > 0)) return 0;
  if (value > 1) return 1;
  return value;
}

const RecordButton = memo(function RecordButton() {
  const phase = useStore((state) => state.phase);
  const svgRef = useRef(null);
  const circRef = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const recording = phase === 'recording';
  const busy = phase === 'requesting' || phase === 'processing';

  const writeRef = useRef(() => {});
  writeRef.current = (relayout) => {
    const svg = svgRef.current;
    if (!svg) return;
    if (relayout || !circRef.current) {
      const rect = svg.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      if (width < 2 || height < 2) return;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.max(0, Math.min(width, height) / 2 - 2);
      const circ = 2 * Math.PI * radius;
      circRef.current = circ;
      svg.querySelectorAll('circle').forEach((node) => {
        node.setAttribute('cx', String(cx));
        node.setAttribute('cy', String(cy));
        node.setAttribute('r', String(radius));
        node.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
      });
      svg.style.setProperty('--circ', `${circ}px`);
      svg.style.setProperty('--spin-on', `${circ * 0.22}px`);
      svg.style.setProperty('--spin-off', `${circ * 0.78}px`);
    }
    const max = controller.maxSeconds || 120;
    const progress = phaseRef.current === 'recording'
      ? clamp01(controller.getElapsed() / max)
      : 0;
    svg.style.setProperty('--dash', `${circRef.current * (1 - progress)}px`);
  };

  useLayoutEffect(() => {
    writeRef.current(true);
    const svg = svgRef.current;
    if (!svg) return undefined;
    const observer = new ResizeObserver(() => writeRef.current(true));
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    writeRef.current(false);
  }, [phase]);

  useFrameLoop(recording, () => writeRef.current(false));

  function onClick() {
    if (busy) return;
    controller.toggleRecord();
  }

  const className = [
    'fr-record',
    'fr-press',
    recording ? 'fr-record--recording' : '',
    phase === 'processing' ? 'fr-record--processing' : '',
    phase === 'requesting' ? 'fr-record--requesting' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      {...pressHandlers}
      onClick={onClick}
      disabled={busy}
      aria-pressed={recording}
      aria-label={recording ? 'Stop recording' : 'Start recording'}
    >
      <svg ref={svgRef} className="fr-record__svg" aria-hidden="true">
        <circle className="fr-record__track" />
        <circle className="fr-record__progress" />
        <circle className="fr-record__spin" />
      </svg>
      <span className="fr-record__disc" />
    </button>
  );
});

export default RecordButton;
