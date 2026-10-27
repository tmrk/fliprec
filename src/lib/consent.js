export const CONSENT_KEY = 'fliprec:analytics-consent';

export function getConsent() {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    if (value === 'granted' || value === 'denied') return value;
  } catch {
    /* private mode or denied storage */
  }
  return 'unset';
}

export function setConsent(value) {
  try {
    if (value === 'granted' || value === 'denied') {
      localStorage.setItem(CONSENT_KEY, value);
    }
  } catch {
    /* private mode or denied storage */
  }
}
