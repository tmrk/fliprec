const MIN_PRESS_MS = 110;
const presses = new WeakMap();

function isDisabled(el) {
  return !el || el.disabled || el.getAttribute('aria-disabled') === 'true';
}

function press(event) {
  if (event.button !== 0 || event.isPrimary === false) return;
  const el = event.currentTarget;
  if (isDisabled(el)) return;
  const state = presses.get(el);
  if (state?.timer) {
    clearTimeout(state.timer);
    state.timer = 0;
  }
  presses.set(el, { downAt: performance.now(), timer: 0 });
  el.setAttribute('data-pressed', '');
}

function release(event) {
  const el = event.currentTarget;
  if (!el) return;
  const state = presses.get(el);
  if (!state) {
    el.removeAttribute('data-pressed');
    return;
  }
  if (state.timer) return;
  const remaining = MIN_PRESS_MS - (performance.now() - state.downAt);
  if (remaining > 0) {
    state.timer = setTimeout(() => {
      presses.delete(el);
      el.removeAttribute('data-pressed');
    }, remaining);
    return;
  }
  presses.delete(el);
  el.removeAttribute('data-pressed');
}

export const pressHandlers = {
  onPointerDown: press,
  onPointerUp: release,
  onPointerCancel: release,
  onPointerLeave: release,
  onBlur: release,
};

export function usePressable() {
  return pressHandlers;
}
