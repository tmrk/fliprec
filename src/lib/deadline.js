/**
 * Watchdogs for work that can stall on mobile browsers (a decoder that never calls back, a
 * MediaRecorder that never fires `stop`, a wedged worker). Only visible time counts: iOS freezes
 * background pages, so their work and timers resume together and must not time out on return.
 */

function isHidden() {
  return typeof document !== 'undefined' && document.hidden === true;
}

/**
 * Calls `onExpire` once after `ms` of visible time. Returns a cancel function.
 * @param {() => void} onExpire
 * @param {number} ms
 */
export function visibleTimeout(onExpire, ms) {
  let remaining = Math.max(0, Number(ms) || 0);
  let timer = 0;
  let startedAt = 0;
  let done = false;

  const fire = () => {
    if (done) return;
    finish();
    onExpire();
  };

  const arm = () => {
    if (timer || done) return;
    startedAt = Date.now();
    timer = setTimeout(fire, remaining);
  };

  const disarm = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
  };

  const onVisibility = () => {
    if (isHidden()) disarm();
    else arm();
  };

  function finish() {
    done = true;
    if (timer) clearTimeout(timer);
    timer = 0;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  if (!isHidden()) arm();
  return finish;
}

export function timeoutError(message = 'Timed out') {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

/**
 * Settles like `promise`, or rejects with a TimeoutError after `ms` of visible time.
 * `onTimeout` runs first so the caller can tear down whatever is stuck.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {{ message?: string, onTimeout?: () => void }} [options]
 * @returns {Promise<T>}
 */
export function withDeadline(promise, ms, options = {}) {
  return new Promise((resolve, reject) => {
    const cancel = visibleTimeout(() => {
      try {
        options.onTimeout?.();
      } catch {
        /* teardown is best effort */
      }
      reject(timeoutError(options.message));
    }, ms);
    Promise.resolve(promise).then((value) => {
      cancel();
      resolve(value);
    }, (error) => {
      cancel();
      reject(error);
    });
  });
}
