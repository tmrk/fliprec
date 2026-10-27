import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.jsx';
import { controller } from './engine/controller.js';
import { initAnalytics } from './lib/analytics.js';
import './styles/tokens.css';
import './styles/global.css';

document.addEventListener('touchstart', () => {}, { passive: true });

if (import.meta.env.PROD) {
  registerSW({ immediate: true });
  // Keep the encode worker and its lazy AAC encoder in the precache. Importing the
  // constructor does not start a worker and stays out of the initial script.
  void import('./audio/encode.worker.js?worker');
}

initAnalytics();

async function boot() {
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('preview')) {
    const { installPreview } = await import('./dev/preview.js');
    installPreview();
  }

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  scheduleRestore();
}

function scheduleRestore() {
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('preview')) return;
  const run = () => {
    controller.restore();
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run);
  else window.setTimeout(run, 0);
}

boot();
