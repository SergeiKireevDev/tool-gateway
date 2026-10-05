'use client';

import { useState } from 'react';
import type { RunActivity } from '@/lib/launchpad';
import { Badge, EmptyState } from '../ui';
import { VIZ } from './RunBits';

interface ToolCount {
  tool: string;
  allowed: number;
  denied: number;
}

const PERCENT = 100;

function countByTool(calls: RunActivity[]): ToolCount[] {
  const counts = new Map<string, ToolCount>();
  for (const c of calls) {
    const tool = c.tool ?? '?';
    const entry = counts.get(tool) ?? { tool, allowed: 0, denied: 0 };
    if (c.decision === 'denied') entry.denied += 1;
    else entry.allowed += 1;
    counts.set(tool, entry);
  }
  return [...counts.values()].sort((a, b) => b.allowed + b.denied - (a.allowed + a.denied));
}

/** Calls per tool, allowed vs denied: one thin horizontal bar per tool, direct-labeled. */
function ToolBars({ counts }: { counts: ToolCount[] }) {
  const max = Math.max(1, ...counts.map((c) => c.allowed + c.denied));
  return (
    <div className="space-y-3">
      <div className="flex gap-4 text-xs text-slate-600" aria-hidden>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: VIZ.allowed }} /> Allowed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: VIZ.denied }} /> ✕ Denied
        </span>
      </div>
      {counts.map((c) => (
        <div key={c.tool} className="grid grid-cols-[7rem_1fr_9rem] items-center gap-3 text-sm">
          <span className="truncate font-medium text-slate-700">{c.tool}</span>
          <div
            className="flex h-3 gap-0.5"
            title={`${c.tool}: ${c.allowed} allowed, ${c.denied} denied`}
          >
            {c.allowed > 0 && (
              <div
                className="h-full rounded-sm"
                style={{ width: `${(c.allowed / max) * PERCENT}%`, background: VIZ.allowed }}
              />
            )}
            {c.denied > 0 && (
              <div
                className="h-full rounded-sm"
                style={{ width: `${(c.denied / max) * PERCENT}%`, background: VIZ.denied }}
              />
            )}
          </div>
          <span className="text-right text-xs text-slate-600">
            {c.allowed} allowed
            {c.denied > 0 && <span className="text-red-700"> · {c.denied} denied</span>}
          </span>
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
                  <Badge tone={c.decision === 'denied' ? 'red' : 'green'}>
                    {c.decision === 'denied' ? '✕ denied' : '✓ allowed'} {c.status}
                  </Badge>
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
