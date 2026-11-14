import { describe, expect, it, vi } from 'vitest';
import { createUpdateGate, watchForUpdates } from '../../src/lib/updates.js';

function fakeDoc() {
  const doc = new EventTarget();
  doc.hidden = false;
  doc.setHidden = (value) => {
    doc.hidden = value;
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  return doc;
}

describe('createUpdateGate', () => {
  it('takes a waiting update only while hidden and idle', () => {
    const doc = fakeDoc();
    let idle = false;
    let notify = () => {};
    const applyUpdate = vi.fn();
    const gate = createUpdateGate({
      applyUpdate,
      isIdle: () => idle,
      subscribe: (cb) => {
        notify = cb;
        return () => {};
      },
      doc,
    });

    doc.setHidden(true);
    expect(applyUpdate).not.toHaveBeenCalled();
    doc.setHidden(false);
    gate.onNeedRefresh();
    expect(applyUpdate).not.toHaveBeenCalled();

    doc.setHidden(true);
    expect(applyUpdate).not.toHaveBeenCalled();
    idle = true;
    notify();
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    doc.setHidden(false);
    doc.setHidden(true);
    expect(applyUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('watchForUpdates', () => {
  it('checks on return at most once per interval and ignores failures', () => {
    const doc = fakeDoc();
    let now = 0;
    const registration = { update: vi.fn(() => Promise.reject(new Error('offline'))) };
    watchForUpdates(registration, { doc, now: () => now, interval: 1000 });
    doc.setHidden(true);
    doc.setHidden(false);
    expect(registration.update).not.toHaveBeenCalled();
    now = 1500;
    doc.setHidden(true);
    doc.setHidden(false);
    doc.setHidden(true);
    doc.setHidden(false);
    expect(registration.update).toHaveBeenCalledTimes(1);
  });
});
