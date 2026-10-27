import { useEffect, useRef } from 'react';

/** rAF while `active` and the document is visible. The callback must not set React state. */
export function useFrameLoop(active, onFrame) {
  const callbackRef = useRef(onFrame);
  callbackRef.current = onFrame;

  useEffect(() => {
    if (!active) return undefined;
    let raf = 0;

    const loop = (now) => {
      callbackRef.current(now);
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      if (raf || document.hidden) return;
      callbackRef.current(performance.now());
      raf = requestAnimationFrame(loop);
    };

    const stop = () => {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active]);
}
