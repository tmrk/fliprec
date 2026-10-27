/**
 * Whether this browser can share `file` via the Web Share API.
 * `canShare` throwing (or missing) means unsupported.
 * @param {File} file
 */
export function canShareFiles(file) {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function') return false;
  if (typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [file] }) === true;
  } catch {
    return false;
  }
}

/**
 * Share `file` with `{ files }` only. WhatsApp on iOS drops the file when
 * title, text, or url is also set.
 * @param {File} file
 * @returns {Promise<'shared' | 'cancelled' | 'unsupported'>}
 */
export async function shareFiles(file) {
  if (!canShareFiles(file)) return 'unsupported';
  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
    if (name === 'AbortError') return 'cancelled';
    if (name === 'NotAllowedError') {
      const activation = new Error('Sharing needs a user gesture');
      activation.kind = 'activation';
      throw activation;
    }
    throw error;
  }
}

/**
 * Trigger a download, then revoke the object URL after 60 s so a slow
 * browser still has time to read it.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}
