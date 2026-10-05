'use client';

import { type RunEvent, toolLabel } from '@/lib/launchpad';
import { EmptyState } from '../ui';

interface Step {
  key: number;
  kind: 'say' | 'tool' | 'error' | 'final';
  title: string;
  detail: string;
  outcome?: 'ok' | 'error' | 'pending';
  result?: string;
}

function toolStep(e: RunEvent): Step {
  const tool = e.tool ?? 'tool';
  return {
    key: e.seq,
    kind: 'tool',
    title: toolLabel(tool),
    detail: e.text.startsWith(tool) ? e.text.slice(tool.length).trim() : e.text,
    outcome: 'pending',
  };
}

const PLAIN: Partial<Record<RunEvent['type'], { kind: Step['kind']; title: string }>> = {
  assistant_text: { kind: 'say', title: 'Agent' },
  error: { kind: 'error', title: 'Error' },
  final: { kind: 'final', title: 'Finished' },
};

/** Pairs each tool call with its result (by call id) and keeps what the agent said in order. */
function buildSteps(events: RunEvent[]): Step[] {
  const steps: Step[] = [];
  const byCall = new Map<string, Step>();
  for (const e of events) {
    const plain = PLAIN[e.type];
    if (plain) steps.push({ key: e.seq, ...plain, detail: e.text });
    if (e.type === 'tool_call') {
      const step = toolStep(e);
      steps.push(step);
      if (e.callId) byCall.set(e.callId, step);
    }
    const step = e.type === 'tool_result' && e.callId ? byCall.get(e.callId) : undefined;
    if (step) {
      step.outcome = (e.data as { isError?: boolean } | null)?.isError === true ? 'error' : 'ok';
      step.result = e.text;
    }
  }
  return steps;
}

const DOT: Record<Step['kind'], string> = {
  say: 'bg-slate-400',
  tool: 'bg-indigo-600',
  error: 'bg-red-600',
  final: 'bg-emerald-600',
};

const OUTCOME: Record<NonNullable<Step['outcome']>, string> = {
  ok: '✓ returned',
  error: '✕ failed',
  pending: '… waiting',
};

const DETAIL_CHARS = 300;
const clipText = (t: string): string =>
  t.length > DETAIL_CHARS ? `${t.slice(0, DETAIL_CHARS)}…` : t;

/** The agent's work as a flow: what it said, which tool it called, and what came back. */
export function RunSteps({ events }: { events: RunEvent[] }) {
  const steps = buildSteps(events);
  if (steps.length === 0) return <EmptyState title="No steps yet" />;
  const toolCalls = steps.filter((s) => s.kind === 'tool');
  const failed = toolCalls.filter((s) => s.outcome === 'error').length;
  return (
    <div>
      <p className="mb-4 text-sm text-slate-600">
        {toolCalls.length} tool call{toolCalls.length === 1 ? '' : 's'}
        {failed > 0 && <span className="text-red-700"> · {failed} failed</span>}
      </p>
      <ol className="relative ml-2 border-l border-slate-200">
        {steps.map((s) => (
          <li key={s.key} className="mb-4 ml-5">
            <span
              className={`absolute -left-1.5 mt-1.5 size-3 rounded-full ring-4 ring-white ${DOT[s.kind]}`}
              aria-hidden
            />
            <div className="text-sm">
              <span className="font-medium text-slate-800">{s.title}</span>
              {s.outcome && (
                <span
                  className={`ml-2 text-xs ${s.outcome === 'error' ? 'text-red-700' : 'text-slate-500'}`}
                >
                  {OUTCOME[s.outcome]}
                </span>
              )}
            </div>
            <p className="mt-0.5 font-mono text-xs break-words whitespace-pre-wrap text-slate-600">
              {clipText(s.detail)}
            </p>
            {s.result && (
              <p className="mt-1 border-l-2 border-slate-200 pl-2 font-mono text-xs break-words whitespace-pre-wrap text-slate-500">
                {clipText(s.result)}
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
