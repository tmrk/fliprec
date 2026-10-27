let installed = false;

/** Pointer vs keyboard, so focus rings appear only after a real key press. */
export function installInputModality() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const root = document.documentElement;

  document.addEventListener('pointerdown', () => {
    root.dataset.input = 'pointer';
  }, { capture: true, passive: true });

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    root.dataset.input = 'keyboard';
  }, { capture: true, passive: true });
}
