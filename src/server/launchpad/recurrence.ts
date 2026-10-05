import { MS_PER_DAY, MS_PER_MINUTE, SECONDS_PER_HOUR, MS_PER_SECOND } from '../units.js';

/** Friendly recurrence presets (no cron): when a schedule runs, in its own time zone. */
export const PRESETS = ['hourly', 'daily', 'weekly', 'monthly'] as const;
export type Preset = (typeof PRESETS)[number];

export interface Recurrence {
  preset: Preset;
  /** 0–59: minute of the hour (every preset). */
  minute: number;
  /** 0–23: hour of the day (daily, weekly, monthly). */
  hour: number;
  /** 0 = Sunday … 6 = Saturday (weekly). */
  weekday: number;
  /** 1–28 (monthly; 28 at most so every month has it). */
  dayOfMonth: number;
  /** IANA time zone, e.g. Europe/Paris. */
  timezone: string;
}

const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND;
const DAYS_PER_WEEK = 7;
const MONTHS_PER_YEAR = 12;
/** Upper bound on candidates tried (DST gaps can skip one). */
const MAX_TRIES = 3;

interface Wall {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock time of an instant in a time zone. */
function wallOf(ms: number, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** Offset of the zone from UTC at an instant, in ms (wall − UTC). */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallOf(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE;
}

/** The instant a wall-clock time happens in a zone (the later one in DST overlaps, shifted in gaps). */
function instantOf(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

/** Candidate run in the period containing `w` (this hour, day, week or month). */
function candidate(r: Recurrence, w: Wall, step: number): number {
  switch (r.preset) {
    case 'hourly':
      return instantOf(w.year, w.month, w.day, w.hour, r.minute, r.timezone) + step * MS_PER_HOUR;
    case 'daily':
      return instantOf(w.year, w.month, w.day + step, r.hour, r.minute, r.timezone);
    case 'weekly': {
      const ahead = (r.weekday - w.weekday + DAYS_PER_WEEK) % DAYS_PER_WEEK;
      return instantOf(
        w.year,
        w.month,
        w.day + ahead + step * DAYS_PER_WEEK,
        r.hour,
        r.minute,
        r.timezone,
      );
    }
    case 'monthly': {
      const months = w.month - 1 + step;
      const year = w.year + Math.floor(months / MONTHS_PER_YEAR);
      return instantOf(
        year,
        (months % MONTHS_PER_YEAR) + 1,
        r.dayOfMonth,
        r.hour,
        r.minute,
        r.timezone,
      );
    }
  }
}

/** The first run strictly after `after` (ms since epoch). */
export function nextRun(r: Recurrence, after: number): number {
  const wall = wallOf(after, r.timezone);
  for (let step = 0; step < MAX_TRIES; step++) {
    const at = candidate(r, wall, step);
    if (at > after) return at;
  }
  // Unreachable for valid recurrences: one more period is always in the future.
  return after + MS_PER_DAY;
}

/** The next `count` runs after `after`, for previews. */
export function nextRuns(r: Recurrence, after: number, count: number): number[] {
  const out: number[] = [];
  let t = after;
  for (let i = 0; i < count; i++) {
    t = nextRun(r, t);
    out.push(t);
  }
  return out;
}
