import { Ellipsis, Share } from 'lucide-react';
import { memo } from 'react';
import { controller } from '../engine/controller.js';
import { useStore } from '../hooks/useStore.js';
import { pressHandlers } from '../lib/pressable.js';
import './SecondaryBar.css';

const SecondaryBar = memo(function SecondaryBar() {
  const status = useStore((state) => state.exports.reversed.status);
  const sheetOpen = useStore((state) => state.sheetOpen);
  const ready = status === 'ready';
  const encoding = status === 'encoding';

  return (
    <div className="fr-secondary">
      <button
        type="button"
        className="fr-pill fr-press fr-secondary__share"
        {...pressHandlers}
        aria-disabled={ready ? 'false' : 'true'}
        onClick={() => controller.share('reversed')}
      >
        {encoding ? (
          <>
            <span className="fr-spinner" aria-hidden="true" />
            <span>Preparing...</span>
          </>
        ) : (
          <>
            <Share size={18} strokeWidth={2} aria-hidden="true" />
            <span>Share reversed</span>
          </>
        )}
      </button>
      <button
        type="button"
        id="fr-more-button"
        className="fr-pill fr-press fr-secondary__more"
        {...pressHandlers}
        aria-label="More options"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        aria-controls="fr-more-sheet"
        onClick={() => controller.openSheet()}
      >
        <Ellipsis size={22} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
});

export default SecondaryBar;
