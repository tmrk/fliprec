import { memo } from 'react';
import { controller } from '../engine/controller.js';
import { useStore } from '../hooks/useStore.js';
import { track } from '../lib/analytics.js';
import { pressHandlers } from '../lib/pressable.js';
import './ConsentCard.css';

const ConsentCard = memo(function ConsentCard() {
  const available = useStore((state) => state.analyticsAvailable);
  const consent = useStore((state) => state.consent);
  if (!available || consent !== 'unset') return null;

  return (
    <aside className="fr-consent">
      <p className="fr-consent__text">
        Allow anonymous usage statistics? Your recordings never leave this device.
      </p>
      <div className="fr-consent__actions">
        <button
          type="button"
          className="fr-btn fr-btn--ghost fr-press"
          {...pressHandlers}
          onClick={() => controller.setConsent(false)}
        >
          Not now
        </button>
        <button
          type="button"
          className="fr-btn fr-btn--fill fr-press fr-press--fill"
          {...pressHandlers}
          onClick={() => {
            controller.setConsent(true);
            track('consent_changed', { value: 'granted' });
          }}
        >
          Allow
        </button>
      </div>
    </aside>
  );
});

export default ConsentCard;
