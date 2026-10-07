'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Api, ApiError } from '@/lib/api';
import type { LaunchOptions, Run, Schedule, Trigger, WebhookOption } from '@/lib/launchpad';
import type { Account } from '@/lib/types';
import { Button, EmptyState, ErrorBanner, Modal, SectionHeader, Select } from '../ui';
import { LaunchForm } from './LaunchForm';
import { RunDetail } from './RunDetail';
import { RunsTable, SchedulesTable, TriggersTable } from './RunLists';

const POLL_MS = 5000;
const HTTP_NOT_FOUND = 404;

/** Runs of one schedule or trigger. */
interface RunsFilter {
  param: 'scheduleId' | 'triggerId';
  id: string;
  name: string;
}

interface Props {
  api: Api;
  /** API base of `api`, for file downloads (`/api/me` or `/api/admin`). */
  base: string;
  admin: boolean;
  accounts: Account[];
}

/** Runs and schedules, with the launch form for members: shared by the member and admin views. */
export function RunsWorkspace({ api, base, admin, accounts }: Props) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookOption[]>([]);
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [runsFilter, setRunsFilter] = useState<RunsFilter | null>(null);
  const [memberFilter, setMemberFilter] = useState('');
  const [launching, setLaunching] = useState(false);

  const load = useCallback(() => {
    const query = new URLSearchParams();
    if (runsFilter) query.set(runsFilter.param, runsFilter.id);
    if (memberFilter) query.set('memberId', memberFilter);
    return Promise.all([
      api<Run[]>('GET', `/launchpad/runs?${query.toString()}`),
      api<Schedule[]>('GET', '/launchpad/schedules'),
      api<Trigger[]>('GET', '/launchpad/triggers'),
      admin ? Promise.resolve(null) : api<LaunchOptions>('GET', '/launchpad'),
      // Webhooks can be off: then there are just no triggers to create.
      admin ? Promise.resolve([]) : api<WebhookOption[]>('GET', '/webhooks').catch(() => []),
    ]).then(
      ([list, scheds, trigs, opts, hooks]) => {
        setRuns(list);
        setSchedules(scheds);
        setTriggers(trigs);
        if (opts) setOptions(opts);
        setWebhooks(hooks);
        setError(null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === HTTP_NOT_FOUND) setOff(true);
        else setError((err as Error).message);
      },
    );
  }, [api, admin, runsFilter, memberFilter]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      clearInterval(id);
    };
  }, [load]);

  if (off) {
    return (
      <EmptyState title="Agent launchpad is off">
        Set LAUNCHPAD_VM_DRIVER on the gateway to launch agents.
      </EmptyState>
    );
  }
  if (selected) {
    return (
      <RunDetail
        api={api}
        runId={selected}
        downloadBase={base}
        showMember={admin}
        onBack={() => {
          setSelected(null);
          void load();
        }}
      />
    );
  }

  const fail = (err: unknown): void => {
    setError((err as Error).message);
  };
  const toggle = (path: string, enabled: boolean): void => {
    api('PATCH', path, { enabled }).then(load, fail);
  };
  const remove = (path: string, what: string): void => {
    if (!confirm(`Delete ${what}? Its past runs are kept.`)) return;
    api('DELETE', path).then(load, fail);
  };
  const members = [...new Map((runs ?? []).map((r) => [r.memberId, r.memberName])).entries()];

  return (
    <section>
      <WorkspaceHeader
        admin={admin}
        options={options}
        error={error}
        onLaunch={() => {
          setLaunching(true);
        }}
      />

      <div className="mb-3 flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold text-slate-700">
          {runsFilter ? `Runs of “${runsFilter.name}”` : 'Runs'}
        </h3>
        <div className="flex items-center gap-3">
          {runsFilter && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRunsFilter(null);
              }}
            >
              Show all runs
            </Button>
          )}
          {admin && (
            <Select
              value={memberFilter}
              onChange={(e) => {
                setMemberFilter(e.target.value);
              }}
              className="w-48"
            >
              <option value="">All members</option>
              {members.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>
      {runs && (
        <RunsTable
          runs={runs}
          showMember={admin}
          onSelect={(r) => {
            setSelected(r.id);
          }}
        />
      )}

      <h3 className="mt-8 mb-3 text-sm font-semibold text-slate-700">Scheduled agents</h3>
      <SchedulesTable
        schedules={schedules}
        showMember={admin}
        canResume={!admin}
        onToggle={(s, enabled) => {
          toggle(`/launchpad/schedules/${s.id}`, enabled);
        }}
        onDelete={(s) => {
          remove(`/launchpad/schedules/${s.id}`, `the schedule "${s.name}"`);
        }}
        onShowRuns={(s) => {
          setRunsFilter({ param: 'scheduleId', id: s.id, name: s.name });
        }}
      />

      <h3 className="mt-8 mb-3 text-sm font-semibold text-slate-700">Webhook-triggered agents</h3>
      <TriggersTable
        triggers={triggers}
        showMember={admin}
        canResume={!admin}
        onToggle={(t, enabled) => {
          toggle(`/launchpad/triggers/${t.id}`, enabled);
        }}
        onDelete={(t) => {
          remove(`/launchpad/triggers/${t.id}`, `the trigger "${t.name}"`);
        }}
        onShowRuns={(t) => {
          setRunsFilter({ param: 'triggerId', id: t.id, name: t.name });
        }}
      />

      {options && (
        <Modal
          wide
          open={launching}
          title="New agent"
          onClose={() => {
            setLaunching(false);
          }}
        >
          <LaunchForm
            api={api}
            options={options}
            accounts={accounts}
            webhooks={webhooks}
            onLaunched={(run) => {
              setLaunching(false);
              setSelected(run.id);
            }}
            onScheduled={() => {
              setLaunching(false);
              void load();
            }}
            onTriggered={() => {
              setLaunching(false);
              void load();
            }}
          />
        </Modal>
      )}
    </section>
  );
}

function WorkspaceHeader({
  admin,
  options,
  error,
  onLaunch,
}: {
  admin: boolean;
  options: LaunchOptions | null;
  error: string | null;
  onLaunch: () => void;
}) {
  return (
    <>
      <SectionHeader
        title={admin ? 'Agent runs' : 'Agents'}
        description={
          admin
            ? 'Every agent launched by every member: what it did, every gateway call it made, and its result.'
            : 'Launch AI agents that work on their own in a disposable VM, with only the permissions of the template you choose. Their tool and model calls all go through the gateway.'
        }
        action={
          !admin && options?.enabled ? <Button onClick={onLaunch}>New agent</Button> : undefined
        }
      />
      <div className="mb-4">
        <ErrorBanner message={error} />
        {!admin && options && !options.enabled && (
          <ErrorBanner message="Launching agents is disabled for you. Ask the gateway admin." />
        )}
      </div>
    </>
  );
}
