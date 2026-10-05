'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import type { ActivityEntry } from '@/lib/types';
import { Badge, Card, EmptyState, ErrorBanner, SectionHeader, useNow } from './ui';

const POLL_MS = 5000;

export function ActivityPanel({ api }: { api: Api }) {
  const now = useNow(POLL_MS);
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api<ActivityEntry[]>('GET', '/activity').then(
        (list) => {
          setEntries(list);
          setError(null);
        },
        (err: unknown) => {
          setError((err as Error).message);
        },
      ),
    [api],
  );

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      clearInterval(id);
    };
  }, [load]);

  return (
    <section>
      <SectionHeader
        title="Activity"
        description="Recent admin, member and launchpad actions and proxied requests (stored in the gateway database, refreshed every few seconds)."
      />
      <div className="mb-4">
        <ErrorBanner message={error} />
      </div>
      {entries?.length === 0 && <EmptyState title="Nothing yet" />}
      {entries && entries.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Session</th>
                <th className="px-4 py-3">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {entries.map((e, i) => (
                <tr key={`${e.at}-${String(i)}`}>
                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-500">
                    {formatRelative(e.at, now)}
                  </td>
                  <td className="px-4 py-2.5">
                    {e.kind === 'proxy' ? (
                      <span className="font-mono text-xs">
                        <span className="font-semibold">{e.method}</span> {e.tool}
                        {e.path}
                      </span>
                    ) : (
                      e.detail
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">
                    {e.sessionLabel ?? e.sessionId ?? '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    {e.kind !== 'proxy' ? (
                      <Badge tone={e.kind === 'admin' ? 'slate' : 'indigo'}>{e.kind}</Badge>
                    ) : (
                      <span className="flex items-center gap-2">
                        <Badge tone={e.decision === 'denied' ? 'red' : 'green'}>
                          {e.decision} {e.status}
                        </Badge>
                        <span className="text-xs text-slate-500">{e.detail}</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
