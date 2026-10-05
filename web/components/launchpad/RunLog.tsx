'use client';

import { useState } from 'react';
import { type RunEvent, type RunEventType, withToolLabel } from '@/lib/launchpad';

const MUTED = 'text-slate-500';

const STYLE: Record<RunEventType, { label: string; className: string }> = {
  status: { label: 'status', className: MUTED },
  assistant_text: { label: 'agent', className: 'text-slate-900' },
  thinking: { label: 'thinking', className: 'text-slate-500 italic' },
  tool_call: { label: 'tool call', className: 'text-indigo-700' },
  tool_result: { label: 'result', className: 'text-slate-600' },
  usage: { label: 'usage', className: MUTED },
  log: { label: 'log', className: MUTED },
  error: { label: 'error', className: 'text-red-700' },
  final: { label: 'final', className: 'font-medium text-emerald-700' },
};

const COLLAPSED_CHARS = 400;

function EventText({ event }: { event: RunEvent }) {
  const [open, setOpen] = useState(false);
  const long = event.text.length > COLLAPSED_CHARS;
  const full = withToolLabel(event.text, event.tool);
  const text = long && !open ? `${full.slice(0, COLLAPSED_CHARS)}…` : full;
  return (
    <span className="break-words whitespace-pre-wrap">
      {text}
      {long && (
        <button
          type="button"
          className="ml-2 text-xs text-indigo-600 hover:underline"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? 'less' : 'more'}
        </button>
      )}
    </span>
  );
}

/** The live transcript: every event the runner reported, oldest first. */
export function RunLog({ events, live }: { events: RunEvent[]; live: boolean }) {
  const [showLogs, setShowLogs] = useState(false);
  const shown = showLogs ? events : events.filter((e) => e.type !== 'log');
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
        <span>
          {events.length} events{live && ' · updating live'}
        </span>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showLogs}
            onChange={(e) => {
              setShowLogs(e.target.checked);
            }}
          />
          Show harness logs
        </label>
      </div>
      <ol className="max-h-[32rem] space-y-1 overflow-y-auto rounded-lg bg-slate-50 p-3 font-mono text-xs ring-1 ring-slate-200">
        {shown.length === 0 && <li className="text-slate-500">No events yet.</li>}
        {shown.map((e) => {
          const style = STYLE[e.type];
          return (
            <li key={e.seq} className={`grid grid-cols-[5rem_5.5rem_1fr] gap-2 ${style.className}`}>
              <span className="text-slate-400">{new Date(e.at).toLocaleTimeString()}</span>
              <span className="text-slate-400">{style.label}</span>
              <EventText event={e} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}
