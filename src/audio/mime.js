/** First supported entry wins. Empty string means "let the browser pick". */
export const RECORDER_MIME_CANDIDATES = Object.freeze([
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  '',
]);

function defaultIsTypeSupported(mime) {
  try {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return false;
    }
    return MediaRecorder.isTypeSupported(mime);
  } catch {
    return false;
  }
}

/**
 * @param {(mime: string) => boolean} [isTypeSupported]
 *   Defaults to `MediaRecorder.isTypeSupported`. May throw on older Safari.
 */
export function pickRecorderMimeType(isTypeSupported = defaultIsTypeSupported) {
  for (let i = 0; i < RECORDER_MIME_CANDIDATES.length; i += 1) {
    const candidate = RECORDER_MIME_CANDIDATES[i];
    if (!candidate) return '';
    try {
      if (typeof isTypeSupported === 'function' && isTypeSupported(candidate)) return candidate;
    } catch {
      // Old Safari can throw from isTypeSupported. Try the next candidate.
    }
  }
  return '';
}

/** File extension for a recorder MIME type. Unknown types stay `.bin`, never `.m4a`. */
export function extensionForMime(mime) {
  const value = String(mime || '').toLowerCase();
  if (value.includes('mp4') || value.includes('m4a') || value.includes('aac')) return 'm4a';
  if (value.includes('webm')) return 'webm';
  if (value.includes('ogg')) return 'ogg';
  return 'bin';
}
