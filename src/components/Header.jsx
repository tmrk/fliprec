import { Ellipsis, Share } from 'lucide-react';
import { memo, useLayoutEffect, useRef } from 'react';
import { controller } from '../engine/controller.js';
import { useStore } from '../hooks/useStore.js';
import { pressHandlers } from '../lib/pressable.js';
import './Header.css';

const Header = memo(function Header() {
  const status = useStore((state) => state.exports.reversed.status);
  const sheetOpen = useStore((state) => state.sheetOpen);
  const ready = status === 'ready';
  const encoding = status === 'encoding';
  const wasReadyRef = useRef(ready);
  const glyphRef = useRef(null);

  useLayoutEffect(() => {
    const wasReady = wasReadyRef.current;
    wasReadyRef.current = ready;
    if (wasReady || !ready) return;
    const glyph = glyphRef.current;
    if (!glyph) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    glyph.classList.remove('fr-header__glyph--pop');
    void glyph.offsetWidth;
    glyph.classList.add('fr-header__glyph--pop');
  }, [ready]);

  return (
    <header className="fr-header">
      <div className="fr-header__brand">
        <svg className="fr-header__mark" viewBox="0 0 32 32" aria-hidden="true">
          <circle className="fr-header__ring" cx="16" cy="16" r="13.2" />
          <circle className="fr-header__disc" cx="16" cy="16" r="8.3" />
          <path className="fr-header__cut" d="M18.7 12.15 12.9 16l5.8 3.85z" />
        </svg>
        <span className="fr-header__name">FlipRec</span>
      </div>
      <div className="fr-header__actions">
        <button
          type="button"
          className="fr-header__btn fr-header__share fr-press"
          {...pressHandlers}
          aria-label="Share reversed"
          aria-disabled={ready ? 'false' : 'true'}
          aria-busy={encoding ? 'true' : undefined}
          onClick={() => controller.share('reversed')}
        >
          {encoding ? (
            <span className="fr-spinner" aria-hidden="true" />
          ) : (
            <span className="fr-header__glyph" ref={glyphRef}>
              <Share size={20} strokeWidth={2} aria-hidden="true" />
            </span>
          )}
        </button>
        <button
          type="button"
          id="fr-more-button"
          className="fr-header__btn fr-press"
          {...pressHandlers}
          aria-label="More options"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          aria-controls="fr-more-sheet"
          onClick={() => controller.openSheet()}
        >
          <Ellipsis size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
});

export default Header;
