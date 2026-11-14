import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/engine/controller.js', () => ({
  controller: {
    setEffect: vi.fn(),
  },
}));

import { controller } from '../../src/engine/controller.js';
import { store } from '../../src/engine/store.js';
import FxButton from '../../src/components/FxButton.jsx';

const roots = [];

async function render(kind) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(createElement(FxButton, { kind }));
  });
  return host;
}

function groupOf(host) {
  return host.querySelector('[role="group"]');
}

beforeEach(() => {
  controller.setEffect.mockClear();
  store.setState({
    phase: 'empty',
    effect: { speed: 1, pitch: 1 },
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = '';
});

describe('FxButton', () => {
  it('is a disabled Speed rocker until a take is ready', async () => {
    const host = await render('speed');
    const group = groupOf(host);
    const [fast, slow] = host.querySelectorAll('button');

    expect(group.getAttribute('aria-label')).toBe('Speed');
    expect(group.className).toBe('fr-fx');
    expect(group.hasAttribute('data-disabled')).toBe(true);
    expect(group.getAttribute('data-side')).toBe('up');
    expect(fast.textContent).toBe('Fast');
    expect(slow.textContent).toBe('Slow');
    expect(fast.className).toContain('fr-fx__half--up');
    expect(slow.className).toContain('fr-fx__half--down');
    expect(fast.getAttribute('aria-pressed')).toBe('false');
    expect(slow.getAttribute('aria-pressed')).toBe('false');
    expect(fast.getAttribute('aria-disabled')).toBe('true');
    expect(slow.getAttribute('aria-disabled')).toBe('true');
    expect(host.querySelector('.fr-fx__thumb').getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('.fr-fx__label').textContent).toBe('Speed');
    expect(host.querySelector('.fr-fx__label').getAttribute('aria-hidden')).toBe('true');

    await act(async () => {
      fast.click();
      slow.click();
    });
    expect(controller.setEffect).not.toHaveBeenCalled();
  });

  it('turns Fast on, switches to Slow, and turns the lit half off', async () => {
    store.setState({ phase: 'ready' });
    const host = await render('speed');
    const group = groupOf(host);
    const fast = host.querySelector('.fr-fx__half--up');
    const slow = host.querySelector('.fr-fx__half--down');

    expect(group.hasAttribute('data-disabled')).toBe(false);
    expect(fast.hasAttribute('aria-disabled')).toBe(false);

    await act(async () => {
      fast.click();
    });
    expect(controller.setEffect).toHaveBeenCalledWith('speed', 2);

    await act(async () => {
      store.setState({ effect: { speed: 2, pitch: 1 } });
    });
    expect(group.classList.contains('fr-fx--on')).toBe(true);
    expect(group.getAttribute('data-side')).toBe('up');
    expect(fast.getAttribute('aria-pressed')).toBe('true');
    expect(slow.getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      slow.click();
    });
    expect(controller.setEffect).toHaveBeenLastCalledWith('speed', 0.5);

    await act(async () => {
      store.setState({ effect: { speed: 0.5, pitch: 1 } });
    });
    expect(group.getAttribute('data-side')).toBe('down');
    expect(fast.getAttribute('aria-pressed')).toBe('false');
    expect(slow.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      slow.click();
    });
    expect(controller.setEffect).toHaveBeenLastCalledWith('speed', 1);
  });

  it('maps High and Low onto pitch', async () => {
    store.setState({ phase: 'ready', effect: { speed: 1, pitch: 2 } });
    const host = await render('pitch');
    const group = groupOf(host);
    const high = host.querySelector('.fr-fx__half--up');
    const low = host.querySelector('.fr-fx__half--down');

    expect(group.getAttribute('aria-label')).toBe('Pitch');
    expect(high.textContent).toBe('High');
    expect(low.textContent).toBe('Low');
    expect(group.classList.contains('fr-fx--on')).toBe(true);
    expect(high.getAttribute('aria-pressed')).toBe('true');
    expect(low.getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      low.click();
    });
    expect(controller.setEffect).toHaveBeenCalledWith('pitch', 0.5);

    await act(async () => {
      high.click();
    });
    expect(controller.setEffect).toHaveBeenLastCalledWith('pitch', 1);
  });
});
