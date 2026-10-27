export function tap() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(8);
    }
  } catch {
    /* vibrate can throw if the document is not focused */
  }
}
