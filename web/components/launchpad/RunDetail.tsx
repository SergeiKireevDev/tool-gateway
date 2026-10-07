'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Api, downloadFile } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import {
  formatBytes,
  HARNESS_LABELS,
  isActive,
  type ModelUsage,
  type OutputFile,
  type Run,
  type RunActivity,
  type RunEvent,
} from '@/lib/launchpad';
import { Button, Card, ErrorBanner, useNow } from '../ui';
import { runDuration, StatusBadge, TokenMeter } from './RunBits';
import { RunLog } from './RunLog';
import { RunSteps } from './RunSteps';
import { RunTools } from './RunTools';

const POLL_MS = 2000;
const TABS = ['log', 'steps', 'tools', 'output'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  log: 'Live log',
  steps: 'Steps',
  tools: 'Gateway calls',
  output: 'Result',
};

interface Loaded {
  run: Run;
  activity: RunActivity[];
  usage: ModelUsage[];
  outputs: OutputFile[];
}

/** Polls a run, its new transcript events and its gateway calls while it is active. */
function useRun(api: Api, runId: string) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef(-1);

  const load = useCallback(async () => {
    try {
      const base = `/launchpad/runs/${runId}`;
      const [run, fresh, activity, usage, outputs] = await Promise.all([
        api<Run>('GET', base),
        api<RunEvent[]>('GET', `${base}/events?after=${String(lastSeq.current)}`),
        api<RunActivity[]>('GET', `${base}/activity`),
        api<ModelUsage[]>('GET', `${base}/usage`),
        api<OutputFile[]>('GET', `${base}/outputs`),
      ]);
      const last = fresh.at(-1);
      if (last) {
        lastSeq.current = Math.max(lastSeq.current, last.seq);
        // Overlapping polls can return the same events: keep each sequence number once.
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.seq));
          return [...prev, ...fresh.filter((e) => !seen.has(e.seq))];
        });
      }
      setLoaded({ run, activity, usage, outputs });
      setError(null);
      return isActive(run.status);
    } catch (err) {
      setError((err as Error).message);
      return true;
    }
  }, [api, runId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async (): Promise<void> => {
      const again = await load();
      if (again && !stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  return { loaded, events, error, reload: load };
}

function Outputs({
  run,
  outputs,
  downloadBase,
}: {
  run: Run;
  outputs: OutputFile[];
  downloadBase: string;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      {run.statusReason && (
        <p className={`text-sm ${run.status === 'succeeded' ? 'text-slate-600' : 'text-red-700'}`}>
          {run.statusReason}
        </p>
      )}
      <section>
        <h4 className="mb-2 text-sm font-semibold text-slate-700">Final message</h4>
        <pre className="rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap text-slate-800 ring-1 ring-slate-200">
          {run.finalMessage ??
            (isActive(run.status) ? 'Not finished yet.' : 'The agent left no final message.')}
        </pre>
      </section>
      <section>
        <h4 className="mb-2 text-sm font-semibold text-slate-700">Files ({outputs.length})</h4>
        <ErrorBanner message={error} />
        {outputs.length === 0 ? (
          <p className="text-sm text-slate-500">No files in /home/agent/out.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200">
            {outputs.map((f) => (
              <li key={f.path} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="font-mono">{f.path}</span>
                <span className="flex items-center gap-3 text-xs text-slate-500">
                  {formatBytes(f.size)} · kept until {formatDateTime(f.expiresAt)}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const path = f.path.split('/').map(encodeURIComponent).join('/');
                      downloadFile(
                        downloadBase,
                        `/launchpad/runs/${run.id}/outputs/${path}`,
                        f.path.split('/').at(-1) ?? 'output',
                      ).catch((err: unknown) => {
                        setError((err as Error).message);
                      });
                    }}
                  >
                    Download
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {(run.memoryIn ?? run.memoryOut) !== null && (
        <section>
          <h4 className="mb-2 text-sm font-semibold text-slate-700">MEMORY.md</h4>
          <pre className="rounded-lg bg-slate-50 p-3 text-xs whitespace-pre-wrap ring-1 ring-slate-200">
            {run.memoryOut ?? run.memoryIn}
          </pre>
        </section>
      )}
    </div>
  );
}

function UsageTable({ usage }: { usage: ModelUsage[] }) {
  if (usage.length === 0) return null;
  return (
    <table className="mt-2 text-xs text-slate-600">
      <tbody>
        {usage.map((u) => (
          <tr key={`${u.provider}/${u.model}`}>
            <td className="pr-3 font-mono">{u.model}</td>
            <td className="pr-3">{u.calls} calls</td>
            <td className="pr-3">{u.input.toLocaleString()} in</td>
            <td className="pr-3">{u.output.toLocaleString()} out</td>
            <td>{(u.cacheRead + u.cacheWrite).toLocaleString()} cache</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The task; for a webhook-triggered run, the trigger's instructions and then the event. */
function RunPrompt({ run }: { run: Run }) {
  return (
    <>
      <p className="mt-2 text-sm whitespace-pre-wrap text-slate-800">
        {run.instructions ?? run.prompt}
      </p>
      {run.instructions !== null && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-slate-500">Webhook event</summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 text-xs whitespace-pre-wrap ring-1 ring-slate-200">
            {run.prompt}
          </pre>
        </details>
      )}
    </>
  );
}

/** One run: status, live log, steps, every gateway call, and its result. */
export function RunDetail({
  api,
  runId,
  downloadBase,
  showMember,
  onBack,
}: {
  api: Api;
  runId: string;
  downloadBase: string;
  showMember: boolean;
  onBack: () => void;
}) {
  const now = useNow();
  const { loaded, events, error, reload } = useRun(api, runId);
  const [tab, setTab] = useState<Tab>('log');
  const [stopping, setStopping] = useState(false);
  if (!loaded) return <ErrorBanner message={error} />;
  const { run } = loaded;

  const stop = async (): Promise<void> => {
    if (!confirm('Stop this agent? Its VM is destroyed and its key revoked.')) return;
    setStopping(true);
    await api('POST', `/launchpad/runs/${run.id}/cancel`).catch(() => undefined);
    await reload();
    setStopping(false);
  };

  return (
    <section>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 text-sm text-indigo-600 hover:underline"
      >
        ← All runs
      </button>
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <StatusBadge status={run.status} />
              <span className="text-sm text-slate-500">
                {HARNESS_LABELS[run.harness]}
                {run.model && ` · ${run.model}`} · {run.templateName}
                {showMember && ` · ${run.memberName}`}
                {run.scheduleId && ' · scheduled'}
                {run.triggerId && ' · webhook'}
              </span>
            </div>
            <RunPrompt run={run} />
            <p className="mt-2 text-xs text-slate-500">
              Launched {formatDateTime(run.createdAt)} · ran {runDuration(run, now)}
              {run.deadline &&
                isActive(run.status) &&
                ` · must finish by ${formatDateTime(run.deadline)}`}
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <TokenMeter used={run.tokensUsed} budget={run.tokenBudget} />
            {isActive(run.status) && (
              <Button variant="danger" size="sm" disabled={stopping} onClick={() => void stop()}>
                Stop agent
              </Button>
            )}
          </div>
        </div>
        <UsageTable usage={loaded.usage} />
      </Card>
      <div className="mt-4">
        <ErrorBanner message={error} />
      </div>
      <nav className="mt-4 mb-4 flex gap-1 border-b border-slate-200" aria-label="Run views">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
            }}
            aria-current={t === tab ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              t === tab
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>
      {tab === 'log' && <RunLog events={events} live={isActive(run.status)} />}
      {tab === 'steps' && <RunSteps events={events} />}
      {tab === 'tools' && <RunTools activity={loaded.activity} />}
      {tab === 'output' && (
        <Outputs run={run} outputs={loaded.outputs} downloadBase={downloadBase} />
      )}
    </section>
  );
}
