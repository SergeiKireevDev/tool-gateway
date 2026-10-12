const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 299;

/**
 * What became of a proxied call: denied by the gateway, or forwarded and then either succeeded
 * (2xx) or failed on the target platform (any other status, including upstream errors).
 */
export type CallOutcome = 'succeeded' | 'failed' | 'denied';

/** The fields of an activity entry that decide its outcome. */
export interface CallResult {
  decision?: 'allowed' | 'denied';
  status?: number;
}

export function callOutcome(entry: CallResult): CallOutcome {
  if (entry.decision === 'denied') return 'denied';
  const { status } = entry;
  if (status === undefined) return 'succeeded';
  return status >= HTTP_SUCCESS_MIN && status <= HTTP_SUCCESS_MAX ? 'succeeded' : 'failed';
}

export const OUTCOME_BADGES: Record<
  CallOutcome,
  { tone: 'green' | 'amber' | 'red'; icon: string; label: string }
> = {
  succeeded: { tone: 'green', icon: '✓', label: 'allowed' },
  failed: { tone: 'amber', icon: '!', label: 'allowed, failed' },
  denied: { tone: 'red', icon: '✕', label: 'denied' },
};
