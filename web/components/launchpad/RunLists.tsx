'use client';

import { formatDateTime, formatRelative } from '@/lib/format';
import {
  describeSchedule,
  formatTokens,
  HARNESS_LABELS,
  type Run,
  type Schedule,
} from '@/lib/launchpad';
import { Badge, Button, Card, EmptyState, useNow } from '../ui';
import { runDuration, StatusBadge } from './RunBits';

const PROMPT_CHARS = 90;
const excerpt = (text: string): string =>
  text.length > PROMPT_CHARS ? `${text.slice(0, PROMPT_CHARS)}…` : text;

export function RunsTable({
  runs,
  showMember,
  onSelect,
}: {
  runs: Run[];
  showMember: boolean;
  onSelect: (run: Run) => void;
}) {
  const now = useNow();
  if (runs.length === 0) return <EmptyState title="No runs yet" />;
  return (
    <Card className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
          <tr>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Task</th>
            {showMember && <th className="px-4 py-3">Member</th>}
            <th className="px-4 py-3">Agent</th>
            <th className="px-4 py-3">Launched</th>
            <th className="px-4 py-3">Duration</th>
            <th className="px-4 py-3 text-right">Tokens</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {runs.map((r) => (
            <tr
              key={r.id}
              className="cursor-pointer hover:bg-slate-50"
              onClick={() => {
                onSelect(r);
              }}
            >
              <td className="px-4 py-3">
                <StatusBadge status={r.status} />
              </td>
              <td className="max-w-md px-4 py-3">
                <div className="truncate text-slate-800">{excerpt(r.prompt)}</div>
                <div className="text-xs text-slate-500">
                  {r.templateName}
                  {r.scheduleId && ' · scheduled'}
                </div>
              </td>
              {showMember && <td className="px-4 py-3 text-slate-600">{r.memberName}</td>}
              <td className="px-4 py-3 whitespace-nowrap text-slate-600">
                {HARNESS_LABELS[r.harness]}
              </td>
              <td
                className="px-4 py-3 whitespace-nowrap text-slate-500"
                title={formatDateTime(r.createdAt)}
              >
                {formatRelative(r.createdAt, now)}
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-slate-500">{runDuration(r, now)}</td>
              <td className="px-4 py-3 text-right text-slate-600">{formatTokens(r.tokensUsed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function SchedulesTable({
  schedules,
  showMember,
  canResume,
  onToggle,
  onDelete,
  onShowRuns,
}: {
  schedules: Schedule[];
  showMember: boolean;
  canResume: boolean;
  onToggle: (s: Schedule, enabled: boolean) => void;
  onDelete: (s: Schedule) => void;
  onShowRuns: (s: Schedule) => void;
}) {
  const now = useNow();
  if (schedules.length === 0) return <EmptyState title="No scheduled agents" />;
  return (
    <Card className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
          <tr>
            <th className="px-4 py-3">Schedule</th>
            {showMember && <th className="px-4 py-3">Member</th>}
            <th className="px-4 py-3">When</th>
            <th className="px-4 py-3">Next run</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {schedules.map((s) => (
            <tr key={s.id}>
              <td className="max-w-sm px-4 py-3">
                <div className="truncate font-medium text-slate-800">{s.name}</div>
                <div className="text-xs text-slate-500">
                  {HARNESS_LABELS[s.harness]}
                  {s.memory !== null && ' · has memory'}
                </div>
              </td>
              {showMember && <td className="px-4 py-3 text-slate-600">{s.memberName}</td>}
              <td className="px-4 py-3 text-slate-600">{describeSchedule(s)}</td>
              <td className="px-4 py-3">
                {s.enabled && s.nextRunAt ? (
                  <span title={formatDateTime(s.nextRunAt)} className="text-slate-600">
                    {formatRelative(s.nextRunAt, now)}
                  </span>
                ) : (
                  <Badge tone="amber">⏸ {s.stoppedReason ?? 'Stopped'}</Badge>
                )}
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-right">
                <span className="inline-flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onShowRuns(s);
                    }}
                  >
                    Runs
                  </Button>
                  {s.enabled ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        onToggle(s, false);
                      }}
                    >
                      Pause
                    </Button>
                  ) : (
                    canResume && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          onToggle(s, true);
                        }}
                      >
                        Resume
                      </Button>
                    )
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      onDelete(s);
                    }}
                  >
                    Delete
                  </Button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
