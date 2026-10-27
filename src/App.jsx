import { useEffect } from 'react';
import { applyThemePreference, store } from './engine/store.js';
import { useStore } from './hooks/useStore.js';
import ConsentCard from './components/ConsentCard.jsx';
import ErrorCard from './components/ErrorCard.jsx';
import Header from './components/Header.jsx';
import LiveRegion from './components/LiveRegion.jsx';
import MoreSheet from './components/MoreSheet.jsx';
import PlayTile from './components/PlayTile.jsx';
import RecordButton from './components/RecordButton.jsx';
import StatusLine from './components/StatusLine.jsx';
import Timer from './components/Timer.jsx';
import Toast from './components/Toast.jsx';
import Waveform from './components/Waveform.jsx';
import './App.css';

export default function App() {
  const error = useStore((state) => state.error);

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
            {error ? <ErrorCard error={error} /> : <Waveform />}
          </div>
        </main>
      </div>
      <div className="fr-controls">
        <RecordButton />
        <div className="fr-playrow">
          <PlayTile direction="forward" />
          <PlayTile direction="reverse" />
        </div>
      </div>
      <Toast />
      <ConsentCard />
      <MoreSheet />
      <LiveRegion />
    </div>
  );
}
