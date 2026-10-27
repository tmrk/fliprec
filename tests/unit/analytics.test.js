import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConsent, setConsent } from '../../src/lib/consent.js';

const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js?id=G-TEST123';
const roots = [];

function gtagScripts() {
  return [...document.querySelectorAll('script')].filter((script) => (
    script.src.includes('googletagmanager.com/gtag/js')
  ));
}

function dataLayerCalls() {
  if (!window.dataLayer) return [];
  return [...window.dataLayer].map((entry) => [...entry]);
}

function events() {
  return dataLayerCalls().filter((call) => call[0] === 'event');
}

function buttonByText(text) {
  return [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === text);
}

async function loadAnalytics(id = 'G-TEST123') {
  vi.stubEnv('VITE_GA_MEASUREMENT_ID', id);
  vi.resetModules();
  return import('../../src/lib/analytics.js');
}

async function render(component) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(component);
  });
  return host;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  document.querySelectorAll('script').forEach((script) => script.remove());
  delete window.dataLayer;
  delete window.gtag;
  for (const key of Object.keys(window)) {
    if (key.startsWith('ga-disable-')) delete window[key];
  }
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = () => ({
      matches: false,
      media: '',
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return false; },
    });
  }
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
});

describe('consent storage', () => {
  it('round-trips granted and denied, and ignores other values', () => {
    expect(getConsent()).toBe('unset');
    setConsent('granted');
    expect(getConsent()).toBe('granted');
    setConsent('denied');
    expect(getConsent()).toBe('denied');
    setConsent('maybe');
    expect(getConsent()).toBe('denied');
  });

  it('treats storage failures as unset and does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getConsent()).toBe('unset');
    expect(() => setConsent('granted')).not.toThrow();
  });
});

describe('analytics', () => {
  it('injects nothing and shows no card when no measurement id is configured', async () => {
    const { analyticsAvailable, initAnalytics, track } = await loadAnalytics('');
    expect(analyticsAvailable()).toBe(false);
    initAnalytics();
    expect(() => track('played_forward', { variant: 'original' })).not.toThrow();
    expect(gtagScripts()).toHaveLength(0);
    expect(window.dataLayer).toBeUndefined();

    const { default: ConsentCard } = await import('../../src/components/ConsentCard.jsx');
    await render(createElement(ConsentCard));
    expect(document.querySelector('.fr-consent')).toBeNull();
  });

  it('disables analytics when the measurement id format is invalid', async () => {
    const { analyticsAvailable, initAnalytics, grant, track } = await loadAnalytics('G-test123');
    expect(analyticsAvailable()).toBe(false);
    initAnalytics();
    grant();
    track('played_forward', {});
    expect(gtagScripts()).toHaveLength(0);
    expect(window.dataLayer).toBeUndefined();
  });

  it('does not inject gtag or record events while consent is unset', async () => {
    const { initAnalytics, track } = await loadAnalytics();
    initAnalytics();
    track('played_forward', { variant: 'original' });
    expect(gtagScripts()).toHaveLength(0);
    expect(window.dataLayer).toBeUndefined();

    const { store } = await import('../../src/engine/store.js');
    expect(store.getState().consent).toBe('unset');
    expect(store.getState().analyticsAvailable).toBe(true);
  });

  it('loads one script on grant, ignores repeated init, and pushes the config', async () => {
    const { grant, initAnalytics } = await loadAnalytics();
    grant();
    initAnalytics();
    initAnalytics();

    expect(gtagScripts()).toHaveLength(1);
    expect(gtagScripts()[0].src).toBe(GTAG_SRC);
    expect(gtagScripts()[0].async).toBe(true);
    expect(localStorage.getItem('fliprec:analytics-consent')).toBe('granted');
    expect(dataLayerCalls()).toEqual(expect.arrayContaining([
      ['consent', 'default', {
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        analytics_storage: 'granted',
      }],
      ['config', 'G-TEST123', {
        anonymize_ip: true,
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
      }],
    ]));
  });

  it('loads from a stored grant without a second script', async () => {
    localStorage.setItem('fliprec:analytics-consent', 'granted');
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();
    initAnalytics();
    expect(gtagScripts()).toHaveLength(1);
    expect(gtagScripts()[0].src).toBe(GTAG_SRC);
  });

  it('drops duplicate events inside 800 ms and strips forbidden params', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
    const { grant, track } = await loadAnalytics();
    grant();

    track('played_forward', { direction: 'forward' });
    track('played_forward', { direction: 'forward' });
    expect(events()).toHaveLength(1);

    vi.advanceTimersByTime(799);
    track('played_forward', { direction: 'forward' });
    expect(events()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    track('played_forward', { direction: 'forward' });
    expect(events()).toHaveLength(2);

    track('audio_imported', {
      file: 'secret.wav',
      name: 'clip',
      blob: 'data',
      audio: 'pcm',
      filename: 'nope.m4a',
      variant: 'reversed',
    });
    expect(events().at(-1)).toEqual(['event', 'audio_imported', { variant: 'reversed' }]);
    expect(() => track('played_forward', undefined)).not.toThrow();
    const circular = {};
    circular.self = circular;
    expect(() => track('played_forward', circular)).not.toThrow();
    expect(track('played_forward', { variant: 'original' })).toBeUndefined();
  });

  it('sets the ga-disable flag on revoke and ignores later events', async () => {
    document.cookie = '_ga=GA1.2.3.4; path=/';
    document.cookie = '_ga_TEST123=1; path=/';
    document.cookie = 'fliprec_keep=1; path=/';
    const { grant, revoke, track } = await loadAnalytics();
    grant();
    track('played_forward', { variant: 'original' });
    revoke();

    expect(window['ga-disable-G-TEST123']).toBe(true);
    expect(localStorage.getItem('fliprec:analytics-consent')).toBe('denied');
    expect(dataLayerCalls()).toEqual(expect.arrayContaining([
      ['consent', 'update', { analytics_storage: 'denied' }],
    ]));
    const count = dataLayerCalls().length;
    track('played_forward', { variant: 'original' });
    track('download_original', {});
    expect(dataLayerCalls()).toHaveLength(count);
    expect(document.cookie).not.toContain('_ga');
    expect(document.cookie).toContain('fliprec_keep=1');
  });

  it('allows from the consent card and denies from Not now', async () => {
    await loadAnalytics();
    const { default: ConsentCard } = await import('../../src/components/ConsentCard.jsx');
    const { store } = await import('../../src/engine/store.js');
    await render(createElement(ConsentCard));
    expect(document.querySelector('.fr-consent')).not.toBeNull();

    await act(async () => {
      buttonByText('Allow').click();
    });
    expect(store.getState().consent).toBe('granted');
    expect(gtagScripts()).toHaveLength(1);
    expect(events()).toEqual([
      ['event', 'consent_changed', { value: 'granted' }],
    ]);
    expect(document.querySelector('.fr-consent')).toBeNull();
  });

  it('denies from Not now without injecting gtag', async () => {
    await loadAnalytics();
    const { default: ConsentCard } = await import('../../src/components/ConsentCard.jsx');
    const { store } = await import('../../src/engine/store.js');
    await render(createElement(ConsentCard));

    await act(async () => {
      buttonByText('Not now').click();
    });
    expect(store.getState().consent).toBe('denied');
    expect(window['ga-disable-G-TEST123']).toBe(true);
    expect(gtagScripts()).toHaveLength(0);
    expect(window.dataLayer).toBeUndefined();
    expect(document.querySelector('.fr-consent')).toBeNull();
  });

  it('reflects and changes the choice from the Analytics row', async () => {
    await loadAnalytics();
    const { default: MoreSheet } = await import('../../src/components/MoreSheet.jsx');
    const { store } = await import('../../src/engine/store.js');
    await render(createElement(MoreSheet));

    const row = () => buttonByText('Analytics');
    expect(row()).not.toBeUndefined();
    expect(row().getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      row().click();
    });
    expect(store.getState().consent).toBe('granted');
    expect(row().getAttribute('aria-checked')).toBe('true');
    expect(gtagScripts()).toHaveLength(1);

    await act(async () => {
      row().click();
    });
    expect(store.getState().consent).toBe('denied');
    expect(row().getAttribute('aria-checked')).toBe('false');
    expect(window['ga-disable-G-TEST123']).toBe(true);
    const count = dataLayerCalls().length;
    const { track } = await import('../../src/lib/analytics.js');
    track('share_completed', {});
    expect(dataLayerCalls()).toHaveLength(count);
  });
});
