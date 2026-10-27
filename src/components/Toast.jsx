import { memo, useEffect } from 'react';
import { controller } from '../engine/controller.js';
import { useStore } from '../hooks/useStore.js';
import { pressHandlers } from '../lib/pressable.js';
import './Toast.css';

const Toast = memo(function Toast() {
  const toast = useStore((state) => state.toast);

  useEffect(() => {
    if (!toast) return undefined;
    const ms = toast.actionLabel || toast.action ? 5000 : 3000;
    const timeout = window.setTimeout(() => controller.dismissToast(), ms);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  if (!toast) return null;

  function onAction() {
    const action = toast.action;
    if (typeof action === 'function') action();
    controller.dismissToast();
  }

  return (
    <div className="fr-toast" role="status">
      <span className="fr-toast__message">{toast.message}</span>
      {toast.actionLabel ? (
        <button type="button" className="fr-toast__action fr-press" {...pressHandlers} onClick={onAction}>
          {toast.actionLabel}
        </button>
      ) : null}
    </div>
  );
});

export default Toast;
