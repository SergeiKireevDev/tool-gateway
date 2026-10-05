'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Api, ApiError } from '@/lib/api';
import type { LaunchOptions, Run, Schedule } from '@/lib/launchpad';
import type { Account } from '@/lib/types';
import { Button, EmptyState, ErrorBanner, Modal, SectionHeader, Select } from '../ui';
import { LaunchForm } from './LaunchForm';
import { RunDetail } from './RunDetail';
import { RunsTable, SchedulesTable } from './RunLists';

const POLL_MS = 5000;
const HTTP_NOT_FOUND = 404;

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
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scheduleFilter, setScheduleFilter] = useState<Schedule | null>(null);
  const [memberFilter, setMemberFilter] = useState('');
  const [launching, setLaunching] = useState(false);

  const load = useCallback(() => {
    const query = new URLSearchParams();
    if (scheduleFilter) query.set('scheduleId', scheduleFilter.id);
    if (memberFilter) query.set('memberId', memberFilter);
    return Promise.all([
      api<Run[]>('GET', `/launchpad/runs?${query.toString()}`),
      api<Schedule[]>('GET', '/launchpad/schedules'),
      admin ? Promise.resolve(null) : api<LaunchOptions>('GET', '/launchpad'),
    ]).then(
      ([list, scheds, opts]) => {
        setRuns(list);
        setSchedules(scheds);
        if (opts) setOptions(opts);
        setError(null);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === HTTP_NOT_FOUND) setOff(true);
        else setError((err as Error).message);
      },
    );
  }, [api, admin, scheduleFilter, memberFilter]);

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

  const toggle = (s: Schedule, enabled: boolean): void => {
    api('PATCH', `/launchpad/schedules/${s.id}`, { enabled }).then(load, (err: unknown) => {
      setError((err as Error).message);
    });
  };
  const remove = (s: Schedule): void => {
    if (!confirm(`Delete the schedule "${s.name}"? Its past runs are kept.`)) return;
    api('DELETE', `/launchpad/schedules/${s.id}`).then(load, (err: unknown) => {
      setError((err as Error).message);
    });
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
          {scheduleFilter ? `Runs of “${scheduleFilter.name}”` : 'Runs'}
        </h3>
        <div className="flex items-center gap-3">
          {scheduleFilter && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setScheduleFilter(null);
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
        onToggle={toggle}
        onDelete={remove}
        onShowRuns={setScheduleFilter}
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
            onLaunched={(run) => {
              setLaunching(false);
              setSelected(run.id);
            }}
            onScheduled={() => {
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
