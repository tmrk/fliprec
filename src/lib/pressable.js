function isDisabled(el) {
  return !el || el.disabled || el.getAttribute('aria-disabled') === 'true';
}

function press(event) {
  if (event.button !== 0 || event.isPrimary === false) return;
  const el = event.currentTarget;
  if (isDisabled(el)) return;
  el.setAttribute('data-pressed', '');
}

function release(event) {
  const el = event.currentTarget;
  if (!el) return;
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
