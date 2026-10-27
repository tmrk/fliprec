import { afterEach, describe, expect, it } from 'vitest';
import {
  RECORDER_MIME_CANDIDATES,
  extensionForMime,
  pickRecorderMimeType,
} from '../../src/audio/mime.js';

const originalMediaRecorder = globalThis.MediaRecorder;

afterEach(() => {
  if (originalMediaRecorder === undefined) delete globalThis.MediaRecorder;
  else globalThis.MediaRecorder = originalMediaRecorder;
});

function support(accepted) {
  const allowed = new Set(accepted);
  return (mime) => allowed.has(mime);
}

describe('RECORDER_MIME_CANDIDATES', () => {
  it('prefers AAC in MP4, then WebM, then Ogg, then the browser default', () => {
    expect([...RECORDER_MIME_CANDIDATES]).toEqual([
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      '',
    ]);
  });
});

describe('pickRecorderMimeType', () => {
  it('picks AAC on a Safari-like support map', () => {
    const safari = support(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4']);
    expect(pickRecorderMimeType(safari)).toBe('audio/mp4;codecs=mp4a.40.2');
    expect(extensionForMime(pickRecorderMimeType(safari))).toBe('m4a');
  });

  it('falls through to audio/mp4 when Safari rejects the codecs string', () => {
    expect(pickRecorderMimeType(support(['audio/mp4']))).toBe('audio/mp4');
  });

  it('picks WebM Opus on a Chrome-like support map', () => {
    const chrome = support(['audio/webm;codecs=opus', 'audio/webm']);
    expect(pickRecorderMimeType(chrome)).toBe('audio/webm;codecs=opus');
    expect(extensionForMime(pickRecorderMimeType(chrome))).toBe('webm');
  });

  it('picks WebM Opus on a Firefox-like map even though Ogg is also supported', () => {
    const firefox = support([
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ]);
    expect(pickRecorderMimeType(firefox)).toBe('audio/webm;codecs=opus');
  });

  it('uses Ogg only when it is the first supported candidate', () => {
    expect(pickRecorderMimeType(support(['audio/ogg;codecs=opus']))).toBe('audio/ogg;codecs=opus');
    expect(extensionForMime('audio/ogg;codecs=opus')).toBe('ogg');
  });

  it('returns an empty string when isTypeSupported throws', () => {
    const throwing = () => {
      throw new Error('isTypeSupported is not implemented');
    };
    expect(pickRecorderMimeType(throwing)).toBe('');
  });

  it('skips candidates that throw and keeps looking', () => {
    const check = (mime) => {
      if (mime.startsWith('audio/mp4')) throw new DOMException('Not supported');
      return mime === 'audio/webm';
    };
    expect(pickRecorderMimeType(check)).toBe('audio/webm');
  });

  it('returns an empty string when MediaRecorder is missing', () => {
    delete globalThis.MediaRecorder;
    expect(pickRecorderMimeType()).toBe('');
  });

  it('uses MediaRecorder.isTypeSupported when no checker is passed', () => {
    globalThis.MediaRecorder = {
      isTypeSupported(mime) {
        return mime === 'audio/mp4';
      },
    };
    expect(pickRecorderMimeType()).toBe('audio/mp4');
  });

  it('survives a MediaRecorder.isTypeSupported that throws', () => {
    globalThis.MediaRecorder = {
      isTypeSupported() {
        throw new Error('invalid');
      },
    };
    expect(pickRecorderMimeType()).toBe('');
  });
});

describe('extensionForMime', () => {
  it('maps known containers and leaves everything else as bin', () => {
    expect(extensionForMime('audio/mp4;codecs=mp4a.40.2')).toBe('m4a');
    expect(extensionForMime('audio/mp4')).toBe('m4a');
    expect(extensionForMime('audio/x-m4a')).toBe('m4a');
    expect(extensionForMime('audio/aac')).toBe('m4a');
    expect(extensionForMime('AUDIO/WEBM;CODECS=OPUS')).toBe('webm');
    expect(extensionForMime('audio/ogg')).toBe('ogg');
    expect(extensionForMime('')).toBe('bin');
    expect(extensionForMime('audio/mpeg')).toBe('bin');
    expect(extensionForMime(undefined)).toBe('bin');
  });
});
