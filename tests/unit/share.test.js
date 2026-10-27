import { afterEach, describe, expect, it, vi } from 'vitest';
import { canShareFiles, downloadBlob, shareFiles } from '../../src/lib/share.js';

const snapshots = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (snapshots.length) {
    const [key, descriptor] = snapshots.pop();
    if (descriptor) Object.defineProperty(navigator, key, descriptor);
    else delete navigator[key];
  }
});

function setNavigator(key, value) {
  snapshots.push([key, Object.getOwnPropertyDescriptor(navigator, key)]);
  Object.defineProperty(navigator, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function file() {
  return new File(['audio'], 'fliprec.m4a', { type: 'audio/mp4' });
}

describe('canShareFiles', () => {
  it('is false when share is missing', () => {
    setNavigator('share', undefined);
    setNavigator('canShare', () => true);
    expect(canShareFiles(file())).toBe(false);
  });

  it('is false when canShare is missing', () => {
    setNavigator('share', vi.fn());
    setNavigator('canShare', undefined);
    expect(canShareFiles(file())).toBe(false);
  });

  it('is false when canShare throws', () => {
    setNavigator('share', vi.fn());
    setNavigator('canShare', () => {
      throw new Error('not allowed');
    });
    expect(canShareFiles(file())).toBe(false);
  });

  it('is false when canShare returns false', () => {
    setNavigator('share', vi.fn());
    setNavigator('canShare', vi.fn(() => false));
    expect(canShareFiles(file())).toBe(false);
  });

  it('is true when canShare accepts the file', () => {
    const audio = file();
    const canShare = vi.fn(() => true);
    setNavigator('share', vi.fn());
    setNavigator('canShare', canShare);
    expect(canShareFiles(audio)).toBe(true);
    expect(canShare).toHaveBeenCalledWith({ files: [audio] });
  });
});

describe('shareFiles', () => {
  it('returns unsupported without calling share when canShare is false', async () => {
    const share = vi.fn();
    setNavigator('share', share);
    setNavigator('canShare', () => false);
    await expect(shareFiles(file())).resolves.toBe('unsupported');
    expect(share).not.toHaveBeenCalled();
  });

  it('returns shared and passes files only', async () => {
    const audio = file();
    const share = vi.fn(() => Promise.resolve());
    setNavigator('share', share);
    setNavigator('canShare', () => true);
    await expect(shareFiles(audio)).resolves.toBe('shared');
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]).toEqual([{ files: [audio] }]);
    expect(Object.keys(share.mock.calls[0][0])).toEqual(['files']);
  });

  it('returns cancelled on AbortError', async () => {
    setNavigator('share', () => Promise.reject(new DOMException('aborted', 'AbortError')));
    setNavigator('canShare', () => true);
    await expect(shareFiles(file())).resolves.toBe('cancelled');
  });

  it('throws kind activation on NotAllowedError', async () => {
    setNavigator('share', () => Promise.reject(new DOMException('gesture', 'NotAllowedError')));
    setNavigator('canShare', () => true);
    await expect(shareFiles(file())).rejects.toMatchObject({ kind: 'activation' });
  });

  it('rethrows other share errors', async () => {
    const error = new Error('offline');
    setNavigator('share', () => Promise.reject(error));
    setNavigator('canShare', () => true);
    await expect(shareFiles(file())).rejects.toBe(error);
  });
});

describe('downloadBlob', () => {
  it('creates an object URL and revokes it after 60s', () => {
    vi.useFakeTimers();
    if (typeof URL.createObjectURL !== 'function') {
      URL.createObjectURL = () => '';
      URL.revokeObjectURL = () => {};
    }
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fliprec');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const blob = new Blob(['audio'], { type: 'audio/mp4' });

    downloadBlob(blob, 'fliprec-original-20261027-093000.m4a');

    expect(create).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    const anchor = click.mock.contexts[0];
    expect(anchor.download).toBe('fliprec-original-20261027-093000.m4a');
    expect(anchor.href).toContain('blob:fliprec');
    expect(anchor.isConnected).toBe(false);
    expect(document.body.querySelector('a')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();

    vi.advanceTimersByTime(59_999);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledWith('blob:fliprec');
  });
});
