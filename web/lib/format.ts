import { MS_PER_SECOND, SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from './units';

const UNITS: [number, string][] = [
  [SECONDS_PER_DAY, 'd'],
  [SECONDS_PER_HOUR, 'h'],
  [SECONDS_PER_MINUTE, 'm'],
  [1, 's'],
];

/** 5400 → "1h 30m" */
export function formatDuration(totalSeconds: number, maxParts = 2): string {
  let rest = Math.max(0, Math.round(totalSeconds));
  if (rest === 0) return '0s';
  const parts: string[] = [];
  for (const [size, unit] of UNITS) {
    if (rest >= size && parts.length < maxParts) {
      parts.push(`${Math.floor(rest / size)}${unit}`);
      rest %= size;
    }
  }
  return parts.join(' ');
}

export function formatRelative(iso: string, now: number): string {
  const diff = (Date.parse(iso) - now) / MS_PER_SECOND;
  const text = formatDuration(Math.abs(diff), 1);
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
