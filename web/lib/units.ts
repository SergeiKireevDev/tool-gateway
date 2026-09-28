export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86400;

/** Pre-filled TTLs in the UI (the server enforces its own limits). */
export const DEFAULT_TTL_SECONDS = SECONDS_PER_HOUR;
const DEFAULT_MAX_TTL_HOURS = 8;
export const DEFAULT_MAX_TTL_SECONDS = DEFAULT_MAX_TTL_HOURS * SECONDS_PER_HOUR;
