/** Truncate to tenths so 59.95 stays 0:59.9 and never rounds up to 0:60 / 1:00. */
export function splitTime(seconds) {
  let value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) value = 0;

  const totalTenths = Math.floor(value * 10 + 1e-8);
  const tenths = totalTenths % 10;
  const whole = Math.floor(totalTenths / 10);
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  const main = `${minutes}:${String(secs).padStart(2, '0')}`;
  const tenthStr = `.${tenths}`;
  return { main, tenths: tenthStr };
}

export function formatTime(seconds) {
  const parts = splitTime(seconds);
  return parts.main + parts.tenths;
}

/** "0:15 left" during the final 15s of a recording, otherwise null. */
export function formatRemaining(elapsed, maxSeconds = 120) {
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const left = maxSeconds - elapsed;
  if (left > 15) return null;
  if (left <= 0) return '0:00 left';
  const shown = Math.min(15, Math.max(0, Math.ceil(left - 1e-6)));
  return `0:${String(shown).padStart(2, '0')} left`;
}

export function formatSpokenSeconds(seconds) {
  const whole = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${whole} ${whole === 1 ? 'second' : 'seconds'}`;
}
