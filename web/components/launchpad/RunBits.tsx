'use client';

import { formatDuration } from '@/lib/format';
import { formatTokens, type Run, type RunStatus } from '@/lib/launchpad';
import { MS_PER_SECOND } from '@/lib/units';
import { Badge } from '../ui';

/** Data-viz roles (validated: see the dataviz palette). */
export const VIZ = {
  allowed: '#2a78d6',
  denied: '#d03b3b',
  track: '#e8eef8',
} as const;

const STATUS: Record<
  RunStatus,
  { tone: 'slate' | 'green' | 'amber' | 'red' | 'brand'; icon: string; label: string }
> = {
  queued: { tone: 'slate', icon: '…', label: 'Queued' },
  provisioning: { tone: 'brand', icon: '◌', label: 'Starting' },
  running: { tone: 'brand', icon: '●', label: 'Running' },
  succeeded: { tone: 'green', icon: '✓', label: 'Succeeded' },
  failed: { tone: 'red', icon: '✕', label: 'Failed' },
  timed_out: { tone: 'amber', icon: '⏱', label: 'Timed out' },
  cancelled: { tone: 'slate', icon: '■', label: 'Stopped' },
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone}>
      <span aria-hidden className="mr-1">
        {s.icon}
      </span>
      {s.label}
    </Badge>
  );
}

/** How long a run took (or has been going). */
/** How the run was launched, when not by hand: " · scheduled" or " · webhook". */
export function runOrigin(run: Run): string {
  if (run.scheduleId) return ' · scheduled';
  return run.triggerId ? ' · webhook' : '';
}

export function runDuration(run: Run, now: number): string {
  if (!run.startedAt) return '—';
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return formatDuration((end - Date.parse(run.startedAt)) / MS_PER_SECOND);
}

const PERCENT = 100;

/** Tokens used against the run's budget: one ratio against a limit, so a meter. */
export function TokenMeter({ used, budget }: { used: number; budget: number | null }) {
  if (budget === null)
    return <span className="text-sm text-slate-600">{formatTokens(used)} tokens</span>;
  const share = Math.min(1, used / budget);
  return (
    <div className="w-48" title={`${used.toLocaleString()} of ${budget.toLocaleString()} tokens`}>
      <div className="flex justify-between text-xs text-slate-600">
        <span>{formatTokens(used)} tokens</span>
        <span>of {formatTokens(budget)}</span>
      </div>
      <div
        className="mt-1 h-2 overflow-hidden rounded-full"
        style={{ background: VIZ.track }}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={used}
        aria-label="Token budget used"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${share * PERCENT}%`, background: VIZ.allowed }}
        />
      </div>
    </div>
  );
}
