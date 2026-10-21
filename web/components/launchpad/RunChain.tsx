'use client';

import { useEffect, useState } from 'react';
import type { Api } from '@/lib/api';
import { formatTokens, HARNESS_LABELS, type Run, runHeadline } from '@/lib/launchpad';
import { useNow } from '../ui';
import { runDuration, StatusBadge } from './RunBits';
import { Arrow, NODE_FRAMES } from './WorkflowView';

const PROMPT_PREVIEW = 80;

/** The run a run is chained after, and the runs chained after it; reloaded with the run. */
function useChain(api: Api, run: Run) {
  const [parent, setParent] = useState<Run | null>(null);
  const [children, setChildren] = useState<Run[]>([]);
  const { id, parentRunId, status } = run;
  useEffect(() => {
    let current = true;
    Promise.all([
      parentRunId ? api<Run>('GET', `/launchpad/runs/${parentRunId}`) : Promise.resolve(null),
      api<Run[]>('GET', `/launchpad/runs?parentRunId=${encodeURIComponent(id)}`),
    ]).then(
      ([p, c]) => {
        if (!current) return;
        setParent(p);
        // Oldest first, left to right like the chain.
        setChildren([...c].reverse());
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [api, id, parentRunId, status]);
  return { parent, children };
}

/** One run of the chain: its agent, task and how far it got. */
function ChainNode({
  run,
  role,
  current,
  now,
  onOpen,
}: {
  run: Run;
  role: string;
  current: boolean;
  now: number;
  onOpen?: () => void;
}) {
  const prompt = runHeadline(run);
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={current || !onOpen}
      aria-current={current ? 'page' : undefined}
      title={current ? undefined : 'Open this run'}
      className={`w-56 shrink-0 rounded-xl border-2 p-3 text-left transition ${NODE_FRAMES[run.status]} ${
        current ? 'ring-2 ring-indigo-600 ring-offset-2' : 'cursor-pointer hover:brightness-95'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-800">{role}</span>
        <StatusBadge status={run.status} />
      </div>
      <div className="mt-1 truncate text-xs text-slate-600">
        {HARNESS_LABELS[run.harness]}
        {run.model && ` · ${run.model}`}
      </div>
      <div className="truncate text-xs text-slate-500" title={prompt}>
        {prompt.slice(0, PROMPT_PREVIEW)}
      </div>
      <div className="mt-1 text-xs text-slate-500">
        {runDuration(run, now)} · {formatTokens(run.tokensUsed)} tokens
      </div>
    </button>
  );
}

/**
 * The chain a run belongs to: the run it started from (its parent) and the runs started from its
 * output files. Nothing when the run is not chained.
 */
export function RunChain({
  api,
  run,
  onOpenRun,
}: {
  api: Api;
  run: Run;
  onOpenRun?: (runId: string) => void;
}) {
  const now = useNow();
  const { parent, children } = useChain(api, run);
  if (!parent && children.length === 0) return null;
  const open = (id: string) =>
    onOpenRun
      ? () => {
          onOpenRun(id);
        }
      : undefined;
  return (
    <div className="mt-4 flex items-center overflow-x-auto py-2" role="list" aria-label="Chain">
      {parent && (
        <div className="flex items-center" role="listitem">
          <ChainNode
            run={parent}
            role="Parent"
            current={false}
            now={now}
            onOpen={open(parent.id)}
          />
          <Arrow passed moving={false} />
        </div>
      )}
      <div className="flex items-center" role="listitem">
        <ChainNode run={run} role="This run" current now={now} />
      </div>
      {children.length > 0 && (
        <div className="flex items-center" role="listitem">
          <Arrow passed moving={false} />
          <div className="flex flex-col gap-2">
            {children.map((child) => (
              <ChainNode
                key={child.id}
                run={child}
                role="Chained"
                current={false}
                now={now}
                onOpen={open(child.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
