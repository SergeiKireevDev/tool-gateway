'use client';

import { useState } from 'react';
import type { Api } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import {
  HARNESS_LABELS,
  type HarnessChoice,
  type LaunchOptions,
  type Preset,
  type Run,
  type Schedule,
  type Trigger,
  type TriggerFilters,
  type WebhookOption,
  WEEKDAYS,
} from '@/lib/launchpad';
import type { Account } from '@/lib/types';
import { Button, ErrorBanner, Field, Input, Select, Textarea } from '../ui';

type When = 'now' | Preset | 'webhook';
const WHEN_LABELS: Record<When, string> = {
  now: 'Run once, now',
  hourly: 'Every hour',
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  webhook: 'On a webhook event',
};
const CREATE_SCHEDULE = 'Create schedule';
const SUBMIT_LABELS: Record<When, string> = {
  now: 'Launch agent',
  hourly: CREATE_SCHEDULE,
  daily: CREATE_SCHEDULE,
  weekly: CREATE_SCHEDULE,
  monthly: CREATE_SCHEDULE,
  webhook: 'Create trigger',
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

const firstId = (items: { id: string }[]): string => items[0]?.id ?? '';

/** Whether the member must type the model: the API has no default and the template names none. */
const typesModel = (choice: HarnessChoice | undefined): boolean =>
  choice !== undefined && choice.modelRequired && choice.models.length === 0;

/** The model to run: one of the template's models, or typed in for a custom endpoint. */
function ModelField({
  choice,
  model,
  setModel,
}: {
  choice: HarnessChoice | undefined;
  model: string;
  setModel: (model: string) => void;
}) {
  if (typesModel(choice)) {
    return (
      <Field label="Model" hint="The model name the custom LLM endpoint serves">
        <Input
          required
          value={model}
          placeholder="e.g. qwen3-coder"
          onChange={(e) => {
            setModel(e.target.value);
          }}
        />
      </Field>
    );
  }
  if (!choice || choice.models.length <= 1) return null;
  return (
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
  );
}

/** "issues.opened, Issue" → ["issues.opened", "Issue"] */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/** A trigger's deterministic filters, as typed: comma-separated lists. */
type FilterDraft = Record<keyof TriggerFilters, string>;
const NO_FILTERS: FilterDraft = { contains: '', statusChangedTo: '', assignedTo: '' };

interface FilterField {
  key: keyof TriggerFilters;
  label: string;
  hint: string;
  placeholder: string;
}

const FILTER_FIELDS: FilterField[] = [
  {
    key: 'contains',
    label: 'Contains',
    hint: 'Only events whose payload contains one of these keywords.',
    placeholder: 'crash, urgent',
  },
  {
    key: 'statusChangedTo',
    label: 'Status changed to',
    hint: 'Only events that move an item to one of these statuses.',
    placeholder: 'Todo, merged',
  },
  {
    key: 'assignedTo',
    label: 'Assigned to',
    hint: 'Only events that assign an item to one of these people (name, email, login or id).',
    placeholder: 'octocat, ada@example.com',
  },
];

const toFilters = (f: FilterDraft): TriggerFilters => ({
  contains: splitList(f.contains),
  statusChangedTo: splitList(f.statusChangedTo),
  assignedTo: splitList(f.assignedTo),
});

/** Optional conditions on the event, checked before an agent is launched. */
function FilterFields({
  filters,
  setFilters,
}: {
  filters: FilterDraft;
  setFilters: (v: FilterDraft) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {FILTER_FIELDS.map((f) => (
        <Field key={f.key} label={f.label} hint={`${f.hint} Comma-separated; empty: any.`}>
          <Input
            value={filters[f.key]}
            onChange={(e) => {
              setFilters({ ...filters, [f.key]: e.target.value });
            }}
            placeholder={f.placeholder}
          />
        </Field>
      ))}
    </div>
  );
}

/** Which of the member's webhooks launches the agent, on which event types and filters. */
function TriggerFields({
  webhooks,
  webhookId,
  setWebhookId,
  eventTypes,
  setEventTypes,
  filters,
  setFilters,
}: {
  webhooks: WebhookOption[];
  webhookId: string;
  setWebhookId: (v: string) => void;
  eventTypes: string;
  setEventTypes: (v: string) => void;
  filters: FilterDraft;
  setFilters: (v: FilterDraft) => void;
}) {
  if (webhooks.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        You have no webhooks yet. Create one under Webhooks first, then come back.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Webhook">
          <Select
            value={webhookId}
            onChange={(e) => {
              setWebhookId(e.target.value);
            }}
          >
            {webhooks.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.source})
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Event types"
          hint="Comma-separated. issues also matches issues.opened. Empty: every event."
        >
          <Input
            value={eventTypes}
            onChange={(e) => {
              setEventTypes(e.target.value);
            }}
            placeholder="issues.opened, Issue.create"
          />
        </Field>
      </div>
      <FilterFields filters={filters} setFilters={setFilters} />
    </div>
  );
}

/** The task field: the agent's task, or what a trigger's agent does with each event. */
function TaskField({
  trigger,
  prompt,
  setPrompt,
}: {
  trigger: boolean;
  prompt: string;
  setPrompt: (v: string) => void;
}) {
  return (
    <Field
      label={trigger ? 'Instructions' : 'Task'}
      hint={
        trigger
          ? 'What the agent should do with each event. They go in its system prompt; the event payload is its task.'
          : 'What the agent should do. It works alone: be specific about the expected result.'
      }
    >
      <Textarea
        required
        rows={6}
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
        }}
        className="font-sans"
        placeholder={
          trigger
            ? 'A new issue was opened: label it, and post a short summary in #triage.'
            : 'Triage the open issues of octo-org/api: label them and post a summary in #triage.'
        }
      />
    </Field>
  );
}

/** What the form holds when it is sent. */
interface Draft {
  when: When;
  prompt: string;
  templateId: string;
  harness: string;
  accountIds: string[];
  model: string;
  time: string;
  weekday: number;
  day: number;
  timezone: string;
  webhookId: string;
  eventTypes: string;
  filters: FilterDraft;
}

const isPreset = (when: When): when is Preset => when !== 'now' && when !== 'webhook';

/** Whether the form holds what its request needs: a task, and for a trigger a webhook. */
function ready(d: Pick<Draft, 'when' | 'prompt' | 'webhookId'>): boolean {
  return d.prompt.trim() !== '' && (d.when !== 'webhook' || d.webhookId !== '');
}

/** The request the form sends: a run now, a schedule, or a webhook trigger. */
function requestFor(d: Draft): { path: string; body: Record<string, unknown> } {
  const launch = {
    templateId: d.templateId,
    harness: d.harness,
    accountIds: d.accountIds,
    ...(d.model ? { model: d.model } : {}),
  };
  if (d.when === 'now') return { path: '/launchpad/runs', body: { ...launch, prompt: d.prompt } };
  if (d.when === 'webhook') {
    return {
      path: '/launchpad/triggers',
      body: {
        ...launch,
        instructions: d.prompt,
        webhookId: d.webhookId,
        eventTypes: splitList(d.eventTypes),
        filters: toFilters(d.filters),
      },
    };
  }
  const { hour, minute } = parseTime(d.time);
  return {
    path: '/launchpad/schedules',
    body: {
      ...launch,
      prompt: d.prompt,
      preset: d.when,
      hour,
      minute,
      weekday: d.weekday,
      dayOfMonth: d.day,
      timezone: d.timezone,
    },
  };
}

/** Launch an agent now, schedule it, or trigger it on webhook events. */
export function LaunchForm({
  api,
  options,
  accounts,
  webhooks,
  onLaunched,
  onScheduled,
  onTriggered,
}: {
  api: Api;
  options: LaunchOptions;
  accounts: Account[];
  /** The member's webhooks, for triggers. */
  webhooks: WebhookOption[];
  onLaunched: (run: Run) => void;
  onScheduled: (schedule: Schedule) => void;
  onTriggered: (trigger: Trigger) => void;
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
  const [webhookId, setWebhookId] = useState(() => firstId(webhooks));
  const [eventTypes, setEventTypes] = useState('');
  const [filters, setFilters] = useState(NO_FILTERS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Tools of the template for which the member has several accounts: they pick one.
  const ambiguous = (template?.tools ?? [])
    .map((tool) => ({ tool, options: accounts.filter((a) => a.tool === tool) }))
    .filter((x) => x.options.length > 1);

  if (usable.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        None of your templates gives access to a model API (Anthropic, OpenAI, Gemini or a custom
        LLM endpoint), which agents need. Ask the gateway admin.
      </p>
    );
  }

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const request = requestFor({
      when,
      prompt,
      templateId,
      harness: choice?.harness ?? harness,
      accountIds: ambiguous.map((x) => picked[x.tool] ?? x.options[0]?.id ?? '').filter(Boolean),
      model: model.trim(),
      time,
      weekday,
      day,
      timezone,
      webhookId,
      eventTypes,
      filters,
    });
    try {
      const sent = await api<Run | Schedule | Trigger>('POST', request.path, request.body);
      if (when === 'now') onLaunched(sent as Run);
      else if (when === 'webhook') onTriggered(sent as Trigger);
      else onScheduled(sent as Schedule);
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
      <TaskField trigger={when === 'webhook'} prompt={prompt} setPrompt={setPrompt} />
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
      <ModelField choice={choice} model={model} setModel={setModel} />
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
      {when === 'webhook' && (
        <TriggerFields
          webhooks={webhooks}
          webhookId={webhookId}
          setWebhookId={setWebhookId}
          eventTypes={eventTypes}
          setEventTypes={setEventTypes}
          filters={filters}
          setFilters={setFilters}
        />
      )}
      {isPreset(when) && (
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
        <Button
          type="submit"
          disabled={
            busy || !ready({ when, prompt, webhookId }) || (typesModel(choice) && !model.trim())
          }
        >
          {SUBMIT_LABELS[when]}
        </Button>
      </div>
    </form>
  );
}
