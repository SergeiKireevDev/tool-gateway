'use client';

import { useState } from 'react';
import type { Api } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import {
  HARNESS_LABELS,
  type LaunchOptions,
  type Preset,
  type Run,
  type Schedule,
  WEEKDAYS,
} from '@/lib/launchpad';
import type { Account } from '@/lib/types';
import { Button, ErrorBanner, Field, Input, Select, Textarea } from '../ui';

type When = 'now' | Preset;
const WHEN_LABELS: Record<When, string> = {
  now: 'Run once, now',
  hourly: 'Every hour',
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
};
const LAST_DAY = 28;
const DAYS = Array.from({ length: LAST_DAY }, (_, i) => i + 1);
const MINUTES_PER_HOUR = 60;

const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function parseTime(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(':').map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

/** Recurrence fields for a schedule: minute (hourly), time, weekday or day of month. */
function RecurrenceFields({
  when,
  time,
  setTime,
  weekday,
  setWeekday,
  day,
  setDay,
  timezone,
  setTimezone,
}: {
  when: Preset;
  time: string;
  setTime: (v: string) => void;
  weekday: number;
  setWeekday: (v: number) => void;
  day: number;
  setDay: (v: number) => void;
  timezone: string;
  setTimezone: (v: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {when === 'hourly' ? (
        <Field label="At minute">
          <Input
            type="number"
            min={0}
            max={MINUTES_PER_HOUR - 1}
            value={parseTime(time).minute}
            onChange={(e) => {
              setTime(`00:${e.target.value.padStart(2, '0')}`);
            }}
          />
        </Field>
      ) : (
        <Field label="At">
          <Input
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
            }}
          />
        </Field>
      )}
      {when === 'weekly' && (
        <Field label="On">
          <Select
            value={weekday}
            onChange={(e) => {
              setWeekday(Number(e.target.value));
            }}
          >
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {when === 'monthly' && (
        <Field label="On day">
          <Select
            value={day}
            onChange={(e) => {
              setDay(Number(e.target.value));
            }}
          >
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Time zone">
        <Input
          value={timezone}
          onChange={(e) => {
            setTimezone(e.target.value);
          }}
        />
      </Field>
    </div>
  );
}

/** Launch an agent now, or schedule it: prompt, permission template, harness, when. */
export function LaunchForm({
  api,
  options,
  accounts,
  onLaunched,
  onScheduled,
}: {
  api: Api;
  options: LaunchOptions;
  accounts: Account[];
  onLaunched: (run: Run) => void;
  onScheduled: (schedule: Schedule) => void;
}) {
  const usable = options.templates.filter((t) => t.harnesses.length > 0);
  const [prompt, setPrompt] = useState('');
  const [templateId, setTemplateId] = useState(usable[0]?.id ?? '');
  const template = usable.find((t) => t.id === templateId);
  const [harness, setHarness] = useState(template?.harnesses[0]?.harness ?? 'claude-code');
  const choice = template?.harnesses.find((h) => h.harness === harness) ?? template?.harnesses[0];
  const [model, setModel] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [when, setWhen] = useState<When>('now');
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState(1);
  const [day, setDay] = useState(1);
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Tools of the template for which the member has several accounts: they pick one.
  const ambiguous = (template?.tools ?? [])
    .map((tool) => ({ tool, options: accounts.filter((a) => a.tool === tool) }))
    .filter((x) => x.options.length > 1);

  if (usable.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        None of your templates gives access to a model API (Anthropic, OpenAI or Gemini), which
        agents need. Ask the gateway admin.
      </p>
    );
  }

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const body = {
      prompt,
      templateId,
      harness: choice?.harness ?? harness,
      accountIds: ambiguous.map((x) => picked[x.tool] ?? x.options[0]?.id ?? '').filter(Boolean),
      ...(model ? { model } : {}),
    };
    try {
      if (when === 'now') {
        onLaunched(await api<Run>('POST', '/launchpad/runs', body));
      } else {
        const { hour, minute } = parseTime(time);
        onScheduled(
          await api<Schedule>('POST', '/launchpad/schedules', {
            ...body,
            preset: when,
            hour,
            minute,
            weekday,
            dayOfMonth: day,
            timezone,
          }),
        );
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field
        label="Task"
        hint="What the agent should do. It works alone: be specific about the expected result."
      >
        <Textarea
          required
          rows={6}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
          }}
          className="font-sans"
          placeholder="Triage the open issues of octo-org/api: label them and post a summary in #triage."
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Permissions"
          hint={
            template
              ? `${template.tools.join(', ')} · keys last up to ${formatDuration(template.maxTtlSeconds)}`
              : undefined
          }
        >
          <Select
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              setModel('');
            }}
          >
            {usable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Agent">
          <Select
            value={choice?.harness ?? harness}
            onChange={(e) => {
              setHarness(e.target.value as typeof harness);
              setModel('');
            }}
          >
            {template?.harnesses.map((h) => (
              <option key={h.harness} value={h.harness}>
                {HARNESS_LABELS[h.harness]} ({h.provider})
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {choice && choice.models.length > 1 && (
        <Field label="Model">
          <Select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
            }}
          >
            <option value="">Default ({choice.models[0]})</option>
            {choice.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {ambiguous.map((x) => (
        <Field
          key={x.tool}
          label={
            x.options[0]?.kind === 'llm'
              ? `Model provider account (${x.tool})`
              : `${x.tool} account`
          }
        >
          <Select
            value={picked[x.tool] ?? x.options[0]?.id}
            onChange={(e) => {
              setPicked({ ...picked, [x.tool]: e.target.value });
            }}
          >
            {x.options.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
      ))}
      <Field label="When">
        <Select
          value={when}
          onChange={(e) => {
            setWhen(e.target.value as When);
          }}
        >
          {(Object.keys(WHEN_LABELS) as When[]).map((w) => (
            <option key={w} value={w}>
              {WHEN_LABELS[w]}
            </option>
          ))}
        </Select>
      </Field>
      {when !== 'now' && (
        <RecurrenceFields
          when={when}
          time={time}
          setTime={setTime}
          weekday={weekday}
          setWeekday={setWeekday}
          day={day}
          setDay={setDay}
          timezone={timezone}
          setTimezone={setTimezone}
        />
      )}
      <ErrorBanner message={error} />
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-slate-500">
          Runs in a disposable VM that can only reach the gateway. Stops after{' '}
          {formatDuration(options.defaultTimeoutSeconds)} at most.
        </p>
        <Button type="submit" disabled={busy || !prompt.trim()}>
          {when === 'now' ? 'Launch agent' : 'Create schedule'}
        </Button>
      </div>
    </form>
  );
}
