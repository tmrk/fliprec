let switchLabel = null;
let tapGuard = false;

function isIosWebKit() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (!/AppleWebKit/i.test(ua)) return false;
  if (/iPad|iPhone|iPod/i.test(ua)) return true;
  // iPadOS desktop mode reports a Mac with touch points.
  const platform = navigator.platform || '';
  return platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
}

function ensureIosSwitch() {
  if (switchLabel || typeof document === 'undefined' || !document.body) return switchLabel;
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.position = 'fixed';
  label.style.left = '0';
  label.style.top = '0';
  label.style.width = '1px';
  label.style.height = '1px';
  label.style.opacity = '0';
  label.style.pointerEvents = 'none';
  label.style.transform = 'translate(-100vw, -100vh)';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  input.style.pointerEvents = 'none';
  label.appendChild(input);
  document.body.appendChild(label);
  switchLabel = label;
  return label;
}

function iosSwitchClick() {
  if (!isIosWebKit()) return;
  const label = ensureIosSwitch();
  if (!label) return;
  const active = document.activeElement;
  const x = window.scrollX;
  const y = window.scrollY;
  label.click();
  const next = document.activeElement;
  if (next && next !== active) {
    if (active && typeof active.focus === 'function' && active !== document.body && active !== document.documentElement) {
      try {
        active.focus({ preventScroll: true });
      } catch {
        /* focus restore can throw on a detached node */
      }
    } else if (typeof next.blur === 'function') {
      try {
        next.blur();
      } catch {
        /* blur can throw if the node is already gone */
      }
    }
  }
  if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
}

export function tap() {
  // The click handler and the controller both call tap() in one turn.
  if (tapGuard) return;
  tapGuard = true;
  if (typeof queueMicrotask === 'function') queueMicrotask(() => {
    tapGuard = false;
  });
  else setTimeout(() => {
    tapGuard = false;
  }, 0);

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(8);
      return;
    }
  } catch {
    return;
  }
  try {
    iosSwitchClick();
  } catch {
    /* the switch trick must never throw */
  }
}
