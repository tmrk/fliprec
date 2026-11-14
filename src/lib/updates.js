// A home screen app can stay resumed for days without a navigation, which is when browsers
// check for a new service worker. Look again on return, at most this often.
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Applies a downloaded app update only while the app is in the background and idle. Taking the
 * update means a reload, which mid-session would stop playback or drop a take being recorded.
 * The last take comes back from IndexedDB after the reload.
 * @param {{ applyUpdate: () => void, isIdle: () => boolean, subscribe?: (cb: () => void) => () => void, doc?: Document }} options
 */
export function createUpdateGate({ applyUpdate, isIdle, subscribe, doc = document }) {
  let waiting = false;
  let applied = false;
  let unsubscribe = null;

  function tryApply() {
    if (!waiting || applied) return;
    if (!doc.hidden || !isIdle()) return;
    applied = true;
    doc.removeEventListener('visibilitychange', tryApply);
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    try {
      applyUpdate();
    } catch {
      /* the update stays waiting for the next launch */
    }
  }

  doc.addEventListener('visibilitychange', tryApply);

  return {
    /** The new version is installed and waiting. */
    onNeedRefresh() {
      waiting = true;
      // A take that finishes processing while the app is hidden makes it idle with no event.
      if (!unsubscribe && typeof subscribe === 'function') unsubscribe = subscribe(tryApply);
      tryApply();
    },
  };
}

/**
 * Asks the registration for an update whenever the app becomes visible and the last check is
 * older than the interval. Failures (offline) are ignored.
 * @param {{ update: () => Promise<unknown> }} registration
 */
export function watchForUpdates(registration, { doc = document, now = () => Date.now(), interval = UPDATE_CHECK_INTERVAL_MS } = {}) {
  let lastCheck = now();
  const onVisibility = () => {
    if (doc.hidden || !registration || typeof registration.update !== 'function') return;
    if (now() - lastCheck < interval) return;
    lastCheck = now();
    try {
      const pending = registration.update();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      /* offline or the registration is gone */
    }
  };
  doc.addEventListener('visibilitychange', onVisibility);
  return () => doc.removeEventListener('visibilitychange', onVisibility);
}
