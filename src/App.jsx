import { lazy, Suspense, useEffect } from 'react';
import { applyThemePreference, store } from './engine/store.js';
import { useStore } from './hooks/useStore.js';
import FxButton from './components/FxButton.jsx';
import Header from './components/Header.jsx';
import LiveRegion from './components/LiveRegion.jsx';
import PlayTile from './components/PlayTile.jsx';
import RecordButton from './components/RecordButton.jsx';
import StatusLine from './components/StatusLine.jsx';
import Timer from './components/Timer.jsx';
import Toast from './components/Toast.jsx';
import Waveform from './components/Waveform.jsx';
import './App.css';

// Rarely shown, so kept out of the entry chunk. All are precached for offline use.
const MoreSheet = lazy(() => import('./components/MoreSheet.jsx'));
const ErrorCard = lazy(() => import('./components/ErrorCard.jsx'));
const ConsentCard = lazy(() => import('./components/ConsentCard.jsx'));

export default function App() {
  const error = useStore((state) => state.error);
  const askConsent = useStore((state) => state.analyticsAvailable && state.consent === 'unset');

  useEffect(() => {
    applyThemePreference(store.getState().theme);
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      if (store.getState().theme === 'system') applyThemePreference('system');
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return (
    <div className="fr-app">
      <div className="fr-app__main">
        <Header />
        <main className={error ? 'fr-stage fr-stage--error' : 'fr-stage'}>
          {error ? null : (
            <>
              <StatusLine />
              <Timer />
            </>
          )}
          <div className="fr-stage__slot">
            {error ? (
              <Suspense fallback={null}>
                <ErrorCard error={error} />
              </Suspense>
            ) : <Waveform />}
          </div>
        </main>
      </div>
      <div className="fr-controls">
        <div className="fr-recrow">
          <FxButton kind="speed" />
          <RecordButton />
          <FxButton kind="pitch" />
        </div>
        <div className="fr-playrow">
          <PlayTile direction="forward" />
          <PlayTile direction="reverse" />
        </div>
      </div>
      <Toast />
      <Suspense fallback={null}>
        {askConsent ? <ConsentCard /> : null}
        <MoreSheet />
      </Suspense>
      <LiveRegion />
    </div>
  );
}
