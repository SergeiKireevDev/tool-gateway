'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Api, ApiError } from '@/lib/api';
import {
  formatTokens,
  type LaunchSettings,
  type MemberLaunch,
  type ModelUsage,
} from '@/lib/launchpad';
import {
  Badge,
  Button,
  Card,
  DurationInput,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  SectionHeader,
} from '../ui';

const HTTP_NOT_FOUND = 404;

type NumberKey =
  | 'maxConcurrentRuns'
  | 'maxConcurrentPerMember'
  | 'tokenBudgetPerRun'
  | 'vcpus'
  | 'memMib'
  | 'outputRetentionDays';
const NUMBER_FIELDS: { key: NumberKey; label: string; hint: string }[] = [
  {
    key: 'maxConcurrentRuns',
    label: 'Agents at once',
    hint: 'Across all members; more wait in the queue.',
  },
  {
    key: 'maxConcurrentPerMember',
    label: 'Agents at once per member',
    hint: 'Default; can be changed per member below.',
  },
  {
    key: 'tokenBudgetPerRun',
    label: 'Token budget per run',
    hint: 'Input + output + cache tokens, enforced by the gateway.',
  },
  { key: 'vcpus', label: 'vCPUs per VM', hint: '' },
  { key: 'memMib', label: 'Memory per VM (MiB)', hint: '' },
  {
    key: 'outputRetentionDays',
    label: 'Keep output files (days)',
    hint: 'Transcripts and gateway calls are kept.',
  },
];

function SettingsForm({
  api,
  settings,
  driver,
  onSaved,
}: {
  api: Api;
  settings: LaunchSettings;
  driver: string;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    api('PUT', '/launchpad/settings', draft).then(
      () => {
        setError(null);
        onSaved();
      },
      (err: unknown) => {
        setError((err as Error).message);
      },
    );
  };
  return (
    <Card className="p-5">
      <p className="mb-4 text-sm text-slate-600">
        VM driver: <Badge tone={driver === 'local-unsafe' ? 'red' : 'brand'}>{driver}</Badge>
        {driver === 'local-unsafe' && ' — agents run without isolation: development only.'}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Default run time limit">
          <DurationInput
            value={draft.defaultTimeoutSeconds}
            onChange={(v) => {
              setDraft({ ...draft, defaultTimeoutSeconds: v });
            }}
          />
        </Field>
        <Field label="Maximum run time limit" hint="Template key TTLs cap it too.">
          <DurationInput
            value={draft.maxTimeoutSeconds}
            onChange={(v) => {
              setDraft({ ...draft, maxTimeoutSeconds: v });
            }}
          />
        </Field>
        {NUMBER_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint || undefined}>
            <Input
              type="number"
              min={1}
              value={draft[f.key]}
              onChange={(e) => {
                setDraft({ ...draft, [f.key]: Number(e.target.value) });
              }}
            />
          </Field>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between gap-4">
        <ErrorBanner message={error} />
        <Button onClick={save}>Save settings</Button>
      </div>
    </Card>
  );
}

function MemberRights({
  api,
  members,
  onSaved,
}: {
  api: Api;
  members: MemberLaunch[];
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const save = (m: MemberLaunch, patch: Partial<MemberLaunch>): void => {
    const next = { ...m, ...patch };
    api('PUT', `/launchpad/members/${m.memberId}`, {
      launchEnabled: next.launchEnabled,
      maxConcurrent: next.maxConcurrent,
    }).then(onSaved, (err: unknown) => {
      setError((err as Error).message);
    });
  };
  if (members.length === 0) return <EmptyState title="No members" />;
  return (
    <Card className="overflow-x-auto">
      <ErrorBanner message={error} />
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
          <tr>
            <th className="px-4 py-3">Member</th>
            <th className="px-4 py-3">Running</th>
            <th className="px-4 py-3">Agents at once</th>
            <th className="px-4 py-3">Can launch</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {members.map((m) => (
            <tr key={m.memberId}>
              <td className="px-4 py-2.5 font-medium">{m.name}</td>
              <td className="px-4 py-2.5 text-slate-600">{m.activeRuns}</td>
              <td className="px-4 py-2.5">
                <div className="w-28">
                  <Input
                    type="number"
                    min={1}
                    placeholder="default"
                    defaultValue={m.maxConcurrent ?? ''}
                    onBlur={(e) => {
                      const value = e.target.value === '' ? null : Number(e.target.value);
                      if (value !== m.maxConcurrent) save(m, { maxConcurrent: value });
                    }}
                  />
                </div>
              </td>
              <td className="px-4 py-2.5">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={m.launchEnabled}
                    onChange={(e) => {
                      save(m, { launchEnabled: e.target.checked });
                    }}
                  />
                  {m.launchEnabled ? 'Yes' : <Badge tone="red">✕ Disabled</Badge>}
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function UsageByModel({ usage }: { usage: ModelUsage[] }) {
  if (usage.length === 0) return <EmptyState title="No model calls yet" />;
  return (
    <Card className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
          <tr>
            <th className="px-4 py-3">Model</th>
            <th className="px-4 py-3 text-right">Calls</th>
            <th className="px-4 py-3 text-right">Input</th>
            <th className="px-4 py-3 text-right">Output</th>
            <th className="px-4 py-3 text-right">Cache read / write</th>
            <th className="px-4 py-3 text-right">Total tokens</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {usage.map((u) => (
            <tr key={`${u.provider}/${u.model}`}>
              <td className="px-4 py-2.5">
                <span className="font-mono">{u.model}</span>{' '}
                <span className="text-xs text-slate-500">{u.provider}</span>
              </td>
              <td className="px-4 py-2.5 text-right">{u.calls.toLocaleString()}</td>
              <td className="px-4 py-2.5 text-right">{formatTokens(u.input)}</td>
              <td className="px-4 py-2.5 text-right">{formatTokens(u.output)}</td>
              <td className="px-4 py-2.5 text-right">
                {formatTokens(u.cacheRead)} / {formatTokens(u.cacheWrite)}
              </td>
              <td className="px-4 py-2.5 text-right font-medium">{formatTokens(u.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Admin: launchpad limits, per-member launch rights and model usage. */
export function LaunchpadSettingsPanel({ api }: { api: Api }) {
  const [settings, setSettings] = useState<(LaunchSettings & { driver: string }) | null>(null);
  const [members, setMembers] = useState<MemberLaunch[]>([]);
  const [usage, setUsage] = useState<ModelUsage[]>([]);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([
        api<LaunchSettings & { driver: string }>('GET', '/launchpad/settings'),
        api<MemberLaunch[]>('GET', '/launchpad/members'),
        api<ModelUsage[]>('GET', '/launchpad/usage'),
      ]).then(
        ([s, m, u]) => {
          setSettings(s);
          setMembers(m);
          setUsage(u);
        },
        (err: unknown) => {
          if (err instanceof ApiError && err.status === HTTP_NOT_FOUND) setOff(true);
          else setError((err as Error).message);
        },
      ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (off) {
    return (
      <EmptyState title="Agent launchpad is off">
        Set LAUNCHPAD_VM_DRIVER on the gateway to launch agents.
      </EmptyState>
    );
  }
  const { driver = '', ...values } = settings ?? {};
  return (
    <section className="space-y-8">
      <SectionHeader
        title="Launchpad"
        description="Limits for agent runs. A run's key lasts its time limit plus 5 minutes and never longer than its template's max TTL, so give templates meant for agents a max TTL above the run time limit."
      />
      <ErrorBanner message={error} />
      {settings && (
        <SettingsForm
          key={JSON.stringify(values)}
          api={api}
          settings={values as LaunchSettings}
          driver={driver}
          onSaved={() => void load()}
        />
      )}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-slate-700">Members</h3>
        <MemberRights api={api} members={members} onSaved={() => void load()} />
      </div>
      <div>
        <h3 className="mb-3 text-sm font-semibold text-slate-700">
          Model usage (all runs and keys)
        </h3>
        <UsageByModel usage={usage} />
      </div>
    </section>
  );
}
