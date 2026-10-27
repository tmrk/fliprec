import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/audio/sfx.js', () => ({
  playSfx: vi.fn(),
  setSfxEnabled: vi.fn(),
}));

import { playSfx } from '../../src/audio/sfx.js';
import { pressHandlers } from '../../src/lib/pressable.js';

describe('pressHandlers click tick', () => {
  beforeEach(() => {
    playSfx.mockReset();
  });

  it('ticks on click capture for an enabled button', () => {
    const el = document.createElement('button');
    pressHandlers.onClickCapture({ currentTarget: el });
    expect(playSfx).toHaveBeenCalledTimes(1);
    expect(playSfx).toHaveBeenCalledWith('tap');
  });

  it('stays silent when aria-disabled', () => {
    const el = document.createElement('button');
    el.setAttribute('aria-disabled', 'true');
    pressHandlers.onClickCapture({ currentTarget: el });
    expect(playSfx).not.toHaveBeenCalled();
  });

  it('stays silent when data-sfx is off', () => {
    const el = document.createElement('button');
    el.setAttribute('data-sfx', 'off');
    pressHandlers.onClickCapture({ currentTarget: el });
    expect(playSfx).not.toHaveBeenCalled();
  });

  it('does not tick on pointerdown', () => {
    const el = document.createElement('button');
    pressHandlers.onPointerDown({ currentTarget: el, button: 0, isPrimary: true });
    expect(playSfx).not.toHaveBeenCalled();
  });
});
