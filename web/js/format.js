export const UNITS = {
  mi: { label: 'mi', word: 'mile', meters: 1609.344, speed: 'mph', speedFactor: 2.2369363 },
  km: { label: 'km', word: 'kilometer', meters: 1000, speed: 'km/h', speedFactor: 3.6 },
};

export function distance(m, unit) {
  return (m / UNITS[unit].meters).toFixed(2);
}

// Seconds per unit, from meters per second.
export function pace(mps, unit) {
  if (!(mps > 0.3)) return '–:––';
  return clock(UNITS[unit].meters / mps);
}

export function paceFromSeconds(seconds, meters, unit) {
  if (!(meters > 0)) return '–:––';
  return clock(seconds / (meters / UNITS[unit].meters));
}

export function clock(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function date(ms) {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function time(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function percent(x, digits = 1) {
  const v = (x * 100).toFixed(digits);
  if (Number(v) === 0) return `${(0).toFixed(digits)}%`;
  return x > 0 ? `+${v}%` : `${v}%`;
}

// For speech: "8 minutes 5 seconds", "1 hour 2 minutes".
export function spokenDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const out = [];
  if (h) out.push(plural(h, 'hour'));
  if (m) out.push(plural(m, 'minute'));
  if (s % 60 || !out.length) out.push(plural(s % 60, 'second'));
  return out.join(' ');
}

// For speech: "1.55 miles", "3 miles", "1 kilometer".
export function spokenDistance(m, unit) {
  const v = Number((m / UNITS[unit].meters).toFixed(2));
  return v === 1 ? `1 ${UNITS[unit].word}` : `${v} ${UNITS[unit].word}s`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
