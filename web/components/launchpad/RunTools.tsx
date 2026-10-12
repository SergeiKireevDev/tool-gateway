'use client';

import { useState } from 'react';
import { type CallOutcome, callOutcome } from '@/lib/activity';
import type { RunActivity } from '@/lib/launchpad';
import { CallBadge } from '../CallBadge';
import { EmptyState } from '../ui';
import { VIZ } from './RunBits';

type ToolCount = { tool: string } & Record<CallOutcome, number>;

const PERCENT = 100;

/** Bar segments and legend, in display order. */
const SEGMENTS: { outcome: CallOutcome; color: string; legend: string; text: string }[] = [
  { outcome: 'succeeded', color: VIZ.allowed, legend: 'Allowed', text: 'allowed' },
  { outcome: 'failed', color: VIZ.failed, legend: '! Allowed, failed on target', text: 'failed' },
  { outcome: 'denied', color: VIZ.denied, legend: '✕ Denied', text: 'denied' },
];

const SEGMENT_TEXT_CLASS: Record<CallOutcome, string> = {
  succeeded: '',
  failed: 'text-amber-800',
  denied: 'text-red-700',
};

const total = (c: ToolCount): number => c.succeeded + c.failed + c.denied;

const countSummary = (c: ToolCount): string =>
  SEGMENTS.map((s) => [String(c[s.outcome]), s.text].join(' ')).join(', ');

function countByTool(calls: RunActivity[]): ToolCount[] {
  const counts = new Map<string, ToolCount>();
  for (const c of calls) {
    const tool = c.tool ?? '?';
    const entry = counts.get(tool) ?? { tool, succeeded: 0, failed: 0, denied: 0 };
    entry[callOutcome(c)] += 1;
    counts.set(tool, entry);
  }
  return [...counts.values()].sort((a, b) => total(b) - total(a));
}

/** "3 allowed · 1 failed · 2 denied" (zero buckets other than allowed are left out). */
function ToolCountText({ count }: { count: ToolCount }) {
  return (
    <span className="text-right text-xs text-slate-600">
      {SEGMENTS.filter((s) => s.outcome === 'succeeded' || count[s.outcome] > 0).map((s, i) => (
        <span key={s.outcome} className={SEGMENT_TEXT_CLASS[s.outcome]}>
          {i > 0 && ' · '}
          {count[s.outcome]} {s.text}
        </span>
      ))}
    </span>
  );
}

/**
 * Calls per tool — allowed and succeeded, allowed but failed on the target, denied — one thin
 * horizontal bar per tool, direct-labeled.
 */
function ToolBars({ counts }: { counts: ToolCount[] }) {
  const max = Math.max(1, ...counts.map(total));
  return (
    <div className="space-y-3">
      <div className="flex gap-4 text-xs text-slate-600" aria-hidden>
        {SEGMENTS.map((s) => (
          <span key={s.outcome} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} /> {s.legend}
          </span>
        ))}
      </div>
      {counts.map((c) => (
        <div key={c.tool} className="grid grid-cols-[7rem_1fr_12rem] items-center gap-3 text-sm">
          <span className="truncate font-medium text-slate-700">{c.tool}</span>
          <div className="flex h-3 gap-0.5" title={`${c.tool}: ${countSummary(c)}`}>
            {SEGMENTS.filter((s) => c[s.outcome] > 0).map((s) => (
              <div
                key={s.outcome}
                className="h-full rounded-sm"
                style={{ width: `${(c[s.outcome] / max) * PERCENT}%`, background: s.color }}
              />
            ))}
          </div>
          <ToolCountText count={c} />
        </div>
      ))}
    </div>
  );
}

/**
 * Every call the run's session key made through the gateway (tools and the model API), as the
 * gateway logged it — independent of what the agent reports about itself.
 */
export function RunTools({ activity }: { activity: RunActivity[] }) {
  const [filter, setFilter] = useState<string | null>(null);
  const calls = activity.filter((a) => a.kind === 'proxy');
  if (calls.length === 0) return <EmptyState title="No gateway calls yet" />;
  const counts = countByTool(calls);
  const shown = filter ? calls.filter((c) => c.tool === filter) : calls;
  return (
    <div className="space-y-6">
      <ToolBars counts={counts} />
      <div className="flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          className={filter === null ? 'font-semibold text-indigo-700' : 'text-slate-500'}
          onClick={() => {
            setFilter(null);
          }}
        >
          All calls
        </button>
        {counts.map((c) => (
          <button
            key={c.tool}
            type="button"
            className={filter === c.tool ? 'font-semibold text-indigo-700' : 'text-slate-500'}
            onClick={() => {
              setFilter(c.tool);
            }}
          >
            {c.tool}
          </button>
        ))}
      </div>
      <div className="max-h-[28rem] overflow-y-auto rounded-lg ring-1 ring-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="sticky top-0 bg-slate-50 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Call</th>
              <th className="px-3 py-2">Decision</th>
              <th className="px-3 py-2">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {shown.map((c, i) => (
              <tr key={`${c.at}-${String(i)}`}>
                <td className="px-3 py-1.5 whitespace-nowrap text-slate-500">
                  {new Date(c.at).toLocaleTimeString()}
                </td>
                <td className="px-3 py-1.5 font-mono text-xs">
                  <span className="font-semibold">{c.method}</span> {c.tool}
                  {c.path}
                </td>
                <td className="px-3 py-1.5">
                  <CallBadge call={c} />
                </td>
                <td className="px-3 py-1.5 text-xs text-slate-600">{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
