import {
  ChartColumn,
  ChevronDown,
  Download,
  FileAudio,
  FileUp,
  RotateCcw,
  Share,
  Shield,
} from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { controller } from '../engine/controller.js';
import { useStore } from '../hooks/useStore.js';
import { splitTime } from '../lib/format.js';
import { pressHandlers } from '../lib/pressable.js';
import './MoreSheet.css';

const THEMES = [
  ['system', 'System'],
  ['dark', 'Dark'],
  ['light', 'Light'],
];

function focusMore() {
  const button = document.getElementById('fr-more-button');
  if (button) button.focus({ preventScroll: true });
}

function Action({ icon: Icon, label, ariaLabel, onClick, flip, busy }) {
  return (
    <button
      type="button"
      className="fr-action fr-press"
      {...pressHandlers}
      aria-label={ariaLabel}
      aria-disabled={busy ? true : undefined}
      onClick={onClick}
    >
      {busy ? (
        <span className="fr-sheet__spin" aria-hidden="true" />
      ) : (
        <Icon
          className={flip ? 'fr-action__icon fr-action__icon--flip' : 'fr-action__icon'}
          size={22}
          strokeWidth={2}
          aria-hidden="true"
        />
      )}
      <span>{label}</span>
    </button>
  );
}

const MoreSheet = memo(function MoreSheet() {
  const sheetOpen = useStore((state) => state.sheetOpen);
  const theme = useStore((state) => state.theme);
  const consent = useStore((state) => state.consent);
  const analytics = useStore((state) => state.analyticsAvailable);
  const hasRecording = useStore((state) => state.recording != null);
  const reversedStatus = useStore((state) => state.exports.reversed.status);
  const originalStatus = useStore((state) => state.exports.original.status);
  const dialogRef = useRef(null);
  const fileRef = useRef(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const duration = splitTime(controller.getDuration()).main;

  useEffect(() => {
    if (!sheetOpen) setPrivacyOpen(false);
  }, [sheetOpen]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (sheetOpen) {
      dialog.classList.remove('fr-sheet--closing');
      if (!dialog.open) {
        if (!reduce) dialog.classList.add('fr-sheet--prep');
        dialog.showModal();
      }
      const focusDialog = () => {
        dialog.focus({ preventScroll: true });
      };
      focusDialog();
      const first = requestAnimationFrame(() => {
        dialog.classList.remove('fr-sheet--prep');
        focusDialog();
      });
      return () => cancelAnimationFrame(first);
    }

    if (!dialog.open) return undefined;
    if (reduce) {
      dialog.close();
      focusMore();
      return undefined;
    }
    dialog.classList.add('fr-sheet--closing');
    const timeout = window.setTimeout(() => {
      dialog.classList.remove('fr-sheet--closing');
      if (dialog.open) dialog.close();
      focusMore();
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [sheetOpen]);

  function onCancel(event) {
    event.preventDefault();
    controller.closeSheet();
  }

  function onBackdrop(event) {
    const dialog = dialogRef.current;
    if (!dialog || event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    if (!inside) controller.closeSheet();
  }

  function onFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) controller.importFile(file);
  }

  const reversedBusy = reversedStatus === 'encoding';
  const originalBusy = originalStatus === 'encoding';

  return (
    <dialog
      ref={dialogRef}
      id="fr-more-sheet"
      className="fr-sheet"
      tabIndex={-1}
      aria-labelledby="fr-sheet-title"
      onCancel={onCancel}
      onClick={onBackdrop}
    >
      <div className="fr-sheet__grabber" aria-hidden="true" />
      <div className="fr-sheet__body">
        <div className="fr-sheet__head">
          <h2 className="fr-sheet__name" id="fr-sheet-title">Recording</h2>
          <p className="fr-sheet__duration">{duration}</p>
        </div>

        <h3 className="fr-sheet__section">Reversed</h3>
        <div className="fr-actions">
          <Action
            icon={Share}
            label="Share"
            ariaLabel="Share reversed"
            flip
            busy={reversedBusy}
            onClick={() => controller.share('reversed')}
          />
          <Action
            icon={Download}
            label="M4A"
            ariaLabel="Save reversed M4A"
            busy={reversedBusy}
            onClick={() => controller.download('reversed', 'm4a')}
          />
          <Action
            icon={FileAudio}
            label="WAV"
            ariaLabel="Save reversed WAV"
            onClick={() => controller.download('reversed', 'wav')}
          />
        </div>

        <h3 className="fr-sheet__section">Original</h3>
        <div className="fr-actions">
          <Action
            icon={Share}
            label="Share"
            ariaLabel="Share original"
            busy={originalBusy}
            onClick={() => controller.share('original')}
          />
          <Action
            icon={Download}
            label="M4A"
            ariaLabel="Save original M4A"
            busy={originalBusy}
            onClick={() => controller.download('original', 'm4a')}
          />
          <Action
            icon={FileAudio}
            label="WAV"
            ariaLabel="Save original WAV"
            onClick={() => controller.download('original', 'wav')}
          />
        </div>

        <h3 className="fr-sheet__section">Recording</h3>
        <div className="fr-group">
          <button
            type="button"
            className="fr-group__row fr-press"
            {...pressHandlers}
            onClick={() => fileRef.current?.click()}
          >
            <FileUp size={22} strokeWidth={2} aria-hidden="true" />
            <span className="fr-group__label">Import audio...</span>
          </button>
          <button
            type="button"
            className="fr-group__row fr-press"
            {...pressHandlers}
            aria-disabled={hasRecording ? undefined : true}
            onClick={() => {
              if (hasRecording) controller.clearRecording();
            }}
          >
            <RotateCcw size={22} strokeWidth={2} aria-hidden="true" />
            <span className="fr-group__label fr-group__label--rec">New recording</span>
          </button>
        </div>

        <h3 className="fr-sheet__section">Settings</h3>
        <div className="fr-group">
          <div className="fr-group__row fr-group__row--stack">
            <span className="fr-group__caption" id="fr-appearance-label">Appearance</span>
            <div className="fr-segment" role="radiogroup" aria-labelledby="fr-appearance-label">
              {THEMES.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className="fr-segment__btn fr-press"
                  role="radio"
                  aria-checked={theme === value}
                  {...pressHandlers}
                  onClick={() => controller.setTheme(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {analytics ? (
            <button
              type="button"
              className="fr-group__row fr-press"
              role="switch"
              aria-checked={consent === 'granted'}
              {...pressHandlers}
              onClick={() => controller.setConsent(consent !== 'granted')}
            >
              <ChartColumn size={22} strokeWidth={2} aria-hidden="true" />
              <span className="fr-group__label">Analytics</span>
              <span className="fr-switch" aria-hidden="true">
                <span className="fr-switch__knob" />
              </span>
            </button>
          ) : null}

          <button
            type="button"
            className="fr-group__row fr-press"
            aria-expanded={privacyOpen}
            {...pressHandlers}
            onClick={() => setPrivacyOpen((open) => !open)}
          >
            <Shield size={22} strokeWidth={2} aria-hidden="true" />
            <span className="fr-group__label">Privacy</span>
            <ChevronDown
              className={privacyOpen ? 'fr-sheet__chevron fr-sheet__chevron--open' : 'fr-sheet__chevron'}
              size={18}
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>
          {privacyOpen ? (
            <p className="fr-sheet__privacy">
              FlipRec works entirely on your device. Recordings are never uploaded, stored on a
              server, or shared with analytics. Your latest recording is kept only in this browser
              so it survives a reload. Delete it any time with New recording.
            </p>
          ) : null}
        </div>
      </div>
      <div className="fr-sheet__footer">
        <button
          type="button"
          className="fr-sheet__done fr-press"
          {...pressHandlers}
          onClick={() => controller.closeSheet()}
        >
          Done
        </button>
      </div>
      <input
        ref={fileRef}
        className="fr-file"
        type="file"
        accept="audio/*,video/*"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFile}
      />
    </dialog>
  );
});

export default MoreSheet;
