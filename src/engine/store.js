import { analyticsAvailable } from '../lib/analytics.js';
import { getConsent } from '../lib/consent.js';

export const THEME_KEY = 'fliprec:theme';

export function readThemePreference() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'system' || value === 'dark' || value === 'light') return value;
  } catch {
    /* private mode or denied storage */
  }
  return 'dark';
}

export function resolveTheme(pref) {
  if (pref === 'system' && typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return pref === 'light' ? 'light' : 'dark';
}

export function applyThemePreference(pref) {
  if (typeof document === 'undefined') return resolveTheme(pref);
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta && bg) themeMeta.setAttribute('content', bg);
  const scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme) scheme.setAttribute('content', resolved);
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignore */
  }
  return resolved;
}

export function createStore(initial) {
  let state = { ...initial };
  const listeners = new Set();

  function getState() {
    return state;
  }

  function setState(partial) {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    if (patch == null || typeof patch !== 'object') return;
    let changed = false;
    const keys = Object.keys(patch);
    for (let i = 0; i < keys.length; i += 1) {
      if (!Object.is(state[keys[i]], patch[keys[i]])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { getState, setState, subscribe };
}

function createInitialState() {
  return {
    phase: 'empty',
    playback: { state: 'stopped', direction: 'forward' },
    recording: null,
    exports: {
      reversed: { status: 'idle' },
      original: { status: 'idle' },
    },
    error: null,
    toast: null,
    theme: readThemePreference(),
    consent: getConsent(),
    analyticsAvailable: analyticsAvailable(),
    sheetOpen: false,
  };
}

export const store = createStore(createInitialState());
