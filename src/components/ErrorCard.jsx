import { memo } from 'react';
import { controller } from '../engine/controller.js';
import { pressHandlers } from '../lib/pressable.js';
import './ErrorCard.css';

const COPY = {
  'mic-denied': {
    title: 'Microphone blocked',
    body: 'Allow microphone access for this site in your browser settings, then try again.',
  },
  'mic-missing': {
    title: 'No microphone found',
    body: 'Connect a microphone and try again.',
  },
  unsupported: {
    title: 'Browser not supported',
    body: "This browser can't record audio. Try the latest Safari, Chrome, or Firefox.",
  },
  'record-failed': {
    title: 'Recording failed',
    body: 'Something went wrong while recording. Try again.',
  },
  'decode-failed': {
    title: "Couldn't read that audio",
    body: "The file couldn't be decoded. Try a different one.",
  },
};

const ErrorCard = memo(function ErrorCard({ error }) {
  const copy = COPY[error.kind] || {
    title: 'Something went wrong',
    body: error.message || 'Try again.',
  };

  function onRetry() {
    controller.toggleRecord();
    controller.dismissError();
  }

  return (
    <div className="fr-error" role="alert">
      <h2 className="fr-error__title">{copy.title}</h2>
      <p className="fr-error__body">{copy.body}</p>
      <button type="button" className="fr-error__btn fr-press fr-press--fill" {...pressHandlers} data-sfx="off" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
});

export default ErrorCard;
