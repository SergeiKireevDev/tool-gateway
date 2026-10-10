'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import {
  formatTokens,
  HARNESS_LABELS,
  isActive,
  type RunStatus,
  type Workflow,
  WORKFLOW_STEP_LABELS,
  type WorkflowStep,
} from '@/lib/launchpad';
import { Button, Card, ErrorBanner, useNow } from '../ui';
import { runDuration, StatusBadge } from './RunBits';
import { RunDetail } from './RunDetail';

const POLL_MS = 2000;

type NodeState = RunStatus | 'waiting';

/** Node frames by state: what is going stands out, what is left is dashed. */
const NODE_FRAMES: Record<NodeState, string> = {
  waiting: 'border-dashed border-slate-300 bg-slate-50',
  queued: 'border-slate-300 bg-white',
  provisioning: 'border-indigo-400 bg-indigo-50',
  running: 'border-indigo-500 bg-indigo-50 shadow-md shadow-indigo-100',
  succeeded: 'border-green-500 bg-white',
  failed: 'border-red-500 bg-red-50',
  timed_out: 'border-amber-500 bg-amber-50',
  cancelled: 'border-slate-400 bg-slate-50',
};

/** Polls a workflow while it is going. */
function useWorkflow(api: Api, workflowId: string) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const wf = await api<Workflow>('GET', `/launchpad/workflows/${workflowId}`);
      setWorkflow(wf);
      setError(null);
      return isActive(wf.status);
    } catch (err) {
      setError((err as Error).message);
      return true;
    }
  }, [api, workflowId]);

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

  return { workflow, error, reload: load };
}

type Step = Workflow['steps'][number];

/** One step of the graph: what runs it, and how far it got. */
function StepNode({
  step,
  selected,
  now,
  onSelect,
}: {
  step: Step;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const { run } = step;
  const state: NodeState = run?.status ?? 'waiting';
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!run}
      aria-pressed={selected}
      className={`w-56 shrink-0 rounded-xl border-2 p-3 text-left transition ${NODE_FRAMES[state]} ${
        selected ? 'ring-2 ring-indigo-600 ring-offset-2' : ''
      } ${run ? 'cursor-pointer hover:brightness-95' : 'cursor-default'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-800">
          {WORKFLOW_STEP_LABELS[step.step]}
        </span>
        {run ? (
          <StatusBadge status={run.status} />
        ) : (
          <span className="text-xs text-slate-500">Waiting</span>
        )}
      </div>
      <div className="mt-1 truncate text-xs text-slate-600">
        {HARNESS_LABELS[step.harness]}
        {step.model && ` · ${step.model}`}
      </div>
      <div className="truncate text-xs text-slate-500">{step.templateName}</div>
      <div className="mt-1 text-xs text-slate-500">
        {run ? `${runDuration(run, now)} · ${formatTokens(run.tokensUsed)} tokens` : 'Not started'}
      </div>
    </button>
  );
}

/** The edge into a step: drawn once the step before it succeeded, moving while it starts. */
function Edge({ from, to }: { from: Step; to: Step }) {
  const passed = from.run?.status === 'succeeded';
  const starting = passed && (!to.run || to.run.status === 'queued');
  return (
    <svg
      aria-hidden
      viewBox="0 0 48 16"
      className={`h-4 w-12 shrink-0 ${passed ? 'text-green-500' : 'text-slate-300'} ${
        starting ? 'animate-pulse' : ''
      }`}
    >
      <line
        x1="0"
        y1="8"
        x2="40"
        y2="8"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={passed ? undefined : '4 3'}
      />
      <path d="M40 3 L48 8 L40 13 Z" fill="currentColor" />
    </svg>
  );
}

/** The workflow as a graph of its steps; progression shows on the nodes and edges. */
export function WorkflowGraph({
  workflow,
  selected,
  onSelect,
}: {
  workflow: Workflow;
  selected: WorkflowStep | null;
  onSelect: (step: WorkflowStep) => void;
}) {
  const now = useNow();
  return (
    <div className="flex items-center overflow-x-auto py-2" role="list" aria-label="Workflow steps">
      {workflow.steps.map((step, i) => {
        const before = workflow.steps[i - 1];
        return (
          <div key={step.step} className="flex items-center" role="listitem">
            {before && <Edge from={before} to={step} />}
            <StepNode
              step={step}
              selected={selected === step.step}
              now={now}
              onSelect={() => {
                onSelect(step.step);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** The step shown below the graph: the one picked, else the latest one that started. */
function shownStep(workflow: Workflow, picked: WorkflowStep | null): Step | undefined {
  const pickedStep = workflow.steps.find((s) => s.step === picked && s.run);
  return pickedStep ?? workflow.steps.findLast((s) => s.run);
}

/** A workflow: its graph, its task and result, and the run of the step picked in the graph. */
export function WorkflowView({
  api,
  workflowId,
  downloadBase,
  showMember,
  onBack,
}: {
  api: Api;
  workflowId: string;
  downloadBase: string;
  showMember: boolean;
  onBack: () => void;
}) {
  const { workflow, error, reload } = useWorkflow(api, workflowId);
  const [picked, setPicked] = useState<WorkflowStep | null>(null);
  const [stopping, setStopping] = useState(false);
  if (!workflow) return <ErrorBanner message={error} />;
  const shown = shownStep(workflow, picked);

  const stop = async (): Promise<void> => {
    if (
      !confirm('Stop this workflow? The step that is going is stopped, and no further step starts.')
    )
      return;
    setStopping(true);
    await api('POST', `/launchpad/workflows/${workflow.id}/cancel`).catch(() => undefined);
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
              <StatusBadge status={workflow.status} />
              <span className="text-sm text-slate-500">
                Workflow · plan, then execute · {workflow.templateName}
                {showMember && ` · ${workflow.memberName}`}
              </span>
            </div>
            <p className="mt-2 text-sm whitespace-pre-wrap text-slate-800">{workflow.prompt}</p>
            <p className="mt-2 text-xs text-slate-500">
              Launched {formatDateTime(workflow.createdAt)}
            </p>
            {workflow.statusReason && workflow.status !== 'succeeded' && (
              <p className="mt-2 text-sm text-red-700">{workflow.statusReason}</p>
            )}
          </div>
          {isActive(workflow.status) && (
            <Button variant="danger" size="sm" disabled={stopping} onClick={() => void stop()}>
              Stop workflow
            </Button>
          )}
        </div>
        <div className="mt-4">
          <WorkflowGraph workflow={workflow} selected={shown?.step ?? null} onSelect={setPicked} />
        </div>
      </Card>
      <div className="mt-4">
        <ErrorBanner message={error} />
      </div>
      {shown?.run && (
        <div className="mt-6">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">
            {WORKFLOW_STEP_LABELS[shown.step]} step
          </h3>
          <RunDetail
            key={shown.run.id}
            api={api}
            runId={shown.run.id}
            downloadBase={downloadBase}
            showMember={showMember}
          />
        </div>
      )}
    </section>
  );
}
