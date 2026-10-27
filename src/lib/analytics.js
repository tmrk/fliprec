import { getConsent, setConsent } from './consent.js';

const ID = import.meta.env.VITE_GA_MEASUREMENT_ID;
const ENABLED = typeof ID === 'string' && /^G-[A-Z0-9]+$/.test(ID);
const SCRIPT_SRC = ENABLED ? `https://www.googletagmanager.com/gtag/js?id=${ID}` : '';
const BLOCKED_KEY = /file|name|blob|audio/i;
const DEDUPE_MS = 800;

let loaded = false;
let granted = false;
let lastKey = '';
let lastAt = 0;

export function analyticsAvailable() {
  return ENABLED;
}

function gtag() {
  window.dataLayer.push(arguments);
}

function loadGtag() {
  try {
    if (!ENABLED || loaded) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = gtag;
    window.gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'granted',
    });
    window.gtag('js', new Date());
    window.gtag('config', ID, {
      anonymize_ip: true,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    if (!document.querySelector(`script[src="${SCRIPT_SRC}"]`)) {
      const script = document.createElement('script');
      script.async = true;
      script.src = SCRIPT_SRC;
      document.head.appendChild(script);
    }
    loaded = true;
    granted = true;
  } catch {
    /* analytics must never throw */
  }
}

export function initAnalytics() {
  try {
    if (ENABLED && getConsent() === 'granted') loadGtag();
  } catch {
    /* analytics must never throw */
  }
}

export function grant() {
  try {
    setConsent('granted');
    granted = true;
    if (ENABLED) window[`ga-disable-${ID}`] = false;
    if (loaded && typeof window.gtag === 'function') {
      window.gtag('consent', 'update', { analytics_storage: 'granted' });
    } else {
      loadGtag();
    }
  } catch {
    /* analytics must never throw */
  }
}

export function revoke() {
  try {
    setConsent('denied');
    granted = false;
    if (ENABLED) window[`ga-disable-${ID}`] = true;
    if (loaded && typeof window.gtag === 'function') {
      window.gtag('consent', 'update', { analytics_storage: 'denied' });
    }
    clearGaCookies();
  } catch {
    /* analytics must never throw */
  }
}

function sanitize(params) {
  const safe = {};
  if (!params || typeof params !== 'object') return safe;
  const keys = Object.keys(params);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (BLOCKED_KEY.test(key)) continue;
    const value = params[key];
    const type = typeof value;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') continue;
    safe[key] = value;
  }
  return safe;
}

export function track(name, params) {
  try {
    if (!ENABLED || !loaded || !granted) return;
    if (window[`ga-disable-${ID}`]) return;
    if (typeof name !== 'string' || name === '') return;
    if (typeof window.gtag !== 'function') return;
    const safe = sanitize(params);
    const key = `${name}\n${JSON.stringify(safe)}`;
    const now = Date.now();
    if (key === lastKey && now - lastAt < DEDUPE_MS) return;
    lastKey = key;
    lastAt = now;
    window.gtag('event', name, safe);
  } catch {
    /* analytics must never throw or block */
  }
}

function cookieDomains(hostname) {
  const domains = [];
  if (!hostname || hostname === 'localhost') return domains;
  const labels = hostname.split('.').filter(Boolean);
  if (labels.every((label) => /^\d+$/.test(label))) return domains;
  domains.push(hostname, `.${hostname}`);
  if (labels.length >= 2) domains.push(`.${labels.slice(-2).join('.')}`);
  if (labels.length >= 3) domains.push(`.${labels.slice(1).join('.')}`);
  return [...new Set(domains)];
}

function clearGaCookies() {
  let header = '';
  try {
    header = document.cookie;
  } catch {
    return;
  }
  if (!header) return;
  const names = [];
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i += 1) {
    const name = parts[i].split('=')[0].trim();
    if (name === '_ga' || name.startsWith('_ga_')) names.push(name);
  }
  if (!names.length) return;

  const paths = ['/', '/fliprec', '/fliprec/'];
  const domains = cookieDomains(location.hostname);
  const expires = 'Thu, 01 Jan 1970 00:00:00 GMT';
  for (let n = 0; n < names.length; n += 1) {
    const name = names[n];
    for (let p = 0; p < paths.length; p += 1) {
      const path = paths[p];
      const base = `${name}=; expires=${expires}; max-age=0; path=${path}`;
      try {
        document.cookie = base;
      } catch {
        /* ignore */
      }
      for (let d = 0; d < domains.length; d += 1) {
        try {
          document.cookie = `${base}; domain=${domains[d]}`;
        } catch {
          /* public suffix or mismatched host */
        }
      }
    }
  }
}
