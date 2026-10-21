'use client';

import { type ReactNode, useEffect, useState } from 'react';
import type { Api } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import {
  type EnvironmentChoice,
  HARNESS_LABELS,
  type HarnessChoice,
  type LaunchOptions,
  type LaunchTemplate,
  type Preset,
  type Run,
  type Schedule,
  type Trigger,
  type TriggerFilters,
  type WebhookOption,
  WEEKDAYS,
  type Workflow,
} from '@/lib/launchpad';
import type { Account } from '@/lib/types';
import { Button, ErrorBanner, Field, Input, Select, Textarea } from '../ui';
import { AttachmentsField, discardAttachments, uploadAttachments } from './AttachmentsField';
import {
  BLANK_DEFAULTS,
  InstructionsField,
  type LaunchDefaults,
  type Relaunch,
  type RelaunchInputs,
  RelaunchNote,
  relaunchDefaults,
  triggerDefaults,
} from './RelaunchFields';
import { SkillsField } from './SkillsField';

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
/** The workflow is picked among the templates, with this select value. */
const WORKFLOW = 'workflow';
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

/** Whether the model the member must type is still missing. */
const lacksModel = (choice: HarnessChoice | undefined, model: string): boolean =>
  typesModel(choice) && !model.trim();

/** Whether the form can be sent: what its request needs, and the models to type. */
function complete(d: {
  when: When;
  prompt: string;
  webhookId: string;
  choice: HarnessChoice | undefined;
  model: string;
  executor: HarnessChoice | undefined;
  executorModel: string;
}): boolean {
  return ready(d) && !lacksModel(d.choice, d.model) && !lacksModel(d.executor, d.executorModel);
}

/** The models a template's custom LLM endpoint serves (within its allowlist), once asked. */
interface EndpointModels {
  templateId: string;
  models: string[];
  error: string | null;
}

/** Asks the gateway which models a custom LLM endpoint serves; null while loading or not custom. */
function useEndpointModels(api: Api, templateId: string, custom: boolean): EndpointModels | null {
  const [listed, setListed] = useState<EndpointModels | null>(null);
  useEffect(() => {
    if (!custom || !templateId) return;
    let current = true;
    api<{ models: string[] }>(
      'GET',
      `/launchpad/templates/${encodeURIComponent(templateId)}/models`,
    ).then(
      (res) => {
        if (current) setListed({ templateId, models: res.models, error: null });
      },
      (err: unknown) => {
        if (current) setListed({ templateId, models: [], error: (err as Error).message });
      },
    );
    return () => {
      current = false;
    };
  }, [api, templateId, custom]);
  return custom && listed?.templateId === templateId ? listed : null;
}

/** Models to propose: the template's exact ones, then those the custom endpoint lists. */
const modelOptions = (choice: HarnessChoice, endpoint: EndpointModels | null): string[] => [
  ...new Set([...choice.models, ...(endpoint?.models ?? [])]),
];

/** Why the member types the model of a custom endpoint instead of picking it. */
function typedModelHint(endpoint: EndpointModels | null): string {
  if (!endpoint) return 'Asking the custom LLM endpoint for its models…';
  if (endpoint.error) return `Couldn’t list the endpoint’s models (${endpoint.error})`;
  return 'The model name the custom LLM endpoint serves';
}

/** The model of a custom endpoint whose template names none: picked from its list, or typed. */
function RequiredModelField({
  label,
  options,
  endpoint,
  model,
  setModel,
}: {
  label: string;
  options: string[];
  endpoint: EndpointModels | null;
  model: string;
  setModel: (model: string) => void;
}) {
  if (options.length === 0) {
    return (
      <Field label={label} hint={typedModelHint(endpoint)}>
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
  return (
    <Field label={label} hint="Models the custom LLM endpoint serves">
      <Select
        required
        value={model}
        onChange={(e) => {
          setModel(e.target.value);
        }}
      >
        <option value="" disabled>
          Choose a model
        </option>
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** The model to run: one of the template's models, or one its custom endpoint serves. */
function ModelField({
  label = 'Model',
  choice,
  endpoint,
  model,
  setModel,
}: {
  label?: string;
  choice: HarnessChoice | undefined;
  endpoint: EndpointModels | null;
  model: string;
  setModel: (model: string) => void;
}) {
  if (!choice) return null;
  const options = modelOptions(choice, endpoint);
  if (typesModel(choice)) {
    return (
      <RequiredModelField
        label={label}
        options={options}
        endpoint={endpoint}
        model={model}
        setModel={setModel}
      />
    );
  }
  if (options.length <= 1) return null;
  return (
    <Field label={label}>
      <Select
        value={model}
        onChange={(e) => {
          setModel(e.target.value);
        }}
      >
        <option value="">Default ({choice.models[0]})</option>
        {options.map((m) => (
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

const toDraft = (f: TriggerFilters): FilterDraft => ({
  contains: f.contains.join(', '),
  statusChangedTo: f.statusChangedTo.join(', '),
  assignedTo: f.assignedTo.join(', '),
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

type TaskKind = 'task' | 'trigger' | 'event';
const TASK_LABELS: Record<TaskKind, string> = {
  task: 'Task',
  trigger: 'Instructions',
  event: 'Webhook event',
};
const TASK_HINTS: Record<TaskKind, string> = {
  task: 'What the agent should do. It works alone: be specific about the expected result.',
  trigger:
    'What the agent should do with each event. They go in its system prompt; the event payload is its task.',
  event: 'The payload of the event that triggered the run: the agent’s task.',
};

/**
 * The task field: the agent's task, what a trigger's agent does with each event, or the event a
 * relaunched triggered run gets again.
 */
function TaskField({
  kind,
  prompt,
  setPrompt,
}: {
  kind: TaskKind;
  prompt: string;
  setPrompt: (v: string) => void;
}) {
  const trigger = kind === 'trigger';
  return (
    <Field label={TASK_LABELS[kind]} hint={TASK_HINTS[kind]}>
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
  /** The trigger being edited, if any: then the form saves it instead of creating one. */
  triggerId: string | null;
  name: string;
  /** A workflow: plan with the agent, then run its script on `executorModel`. */
  workflow: boolean;
  executorModel: string;
  /** The model API a workflow's planning agent uses. */
  plannerProvider: string;
  plannerAccountIds: string[];
  prompt: string;
  templateId: string;
  harness: string;
  accountIds: string[];
  model: string;
  /** The guest environment the agent runs in ('' = the default one). */
  environmentId: string;
  /** Skills of the member's library the agent starts with. */
  skills: string[];
  time: string;
  weekday: number;
  day: number;
  timezone: string;
  webhookId: string;
  eventTypes: string;
  filters: FilterDraft;
  /** The run whose output files the agent starts from ('' = none). */
  parentRunId: string;
  /** Files uploaded for the launch, copied to /home/agent/in. */
  attachmentIds: string[];
  /** A relaunched triggered run's instructions ('' = none). */
  instructions: string;
  /** The relaunched run whose attached files the agent gets again ('' = none). */
  attachmentsFrom: string;
}

const isPreset = (when: When): when is Preset => when !== 'now' && when !== 'webhook';

/** Files are attached to agents launched now (not to workflows, schedules or triggers). */
const attachable = (when: When, workflow: boolean): boolean => when === 'now' && !workflow;

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
  if (d.workflow) {
    const executor = d.executorModel ? { executorModel: d.executorModel } : {};
    return {
      path: '/launchpad/workflows',
      body: {
        ...launch,
        ...executor,
        plannerProvider: d.plannerProvider,
        plannerAccountIds: d.plannerAccountIds,
        prompt: d.prompt,
      },
    };
  }
  // Workflows boot the default environment, with no skills.
  const agent = {
    ...launch,
    ...(d.environmentId ? { environmentId: d.environmentId } : {}),
    ...(d.skills.length > 0 ? { skills: d.skills } : {}),
  };
  if (d.when === 'now') {
    const chain = d.parentRunId ? { parentRunId: d.parentRunId } : {};
    const attached = {
      ...(d.attachmentIds.length > 0 ? { attachmentIds: d.attachmentIds } : {}),
      ...(d.attachmentsFrom ? { attachmentsFrom: d.attachmentsFrom } : {}),
    };
    const instructions = d.instructions.trim() ? { instructions: d.instructions } : {};
    return {
      path: '/launchpad/runs',
      body: { ...agent, ...chain, ...attached, ...instructions, prompt: d.prompt },
    };
  }
  if (d.when === 'webhook') {
    return {
      path: d.triggerId ? `/launchpad/triggers/${d.triggerId}` : '/launchpad/triggers',
      body: {
        ...agent,
        ...(d.name.trim() ? { name: d.name.trim() } : {}),
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
      ...agent,
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

/** The templates that run an agent, then the workflow: picked like any template. */
function TemplateSelect({
  templates,
  value,
  onChange,
  withWorkflow,
}: {
  templates: LaunchTemplate[];
  value: string;
  onChange: (value: string) => void;
  /** Whether the workflow can be picked (not for a chained agent). */
  withWorkflow: boolean;
}) {
  return (
    <Select
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
      }}
    >
      {templates
        .filter((t) => t.harnesses.length > 0)
        .map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      {withWorkflow && (
        <optgroup label="Workflows">
          <option value={WORKFLOW}>Plan, then execute</option>
        </optgroup>
      )}
    </Select>
  );
}

/** The agents and model APIs a workflow's planning step can use, asked once it is picked. */
function usePlanners(api: Api, wanted: boolean) {
  const [planners, setPlanners] = useState<HarnessChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = wanted || planners !== null;
  useEffect(() => {
    if (!asked) return;
    let current = true;
    api<{ planners: HarnessChoice[] }>('GET', '/launchpad/planners').then(
      (res) => {
        if (current) setPlanners(res.planners);
      },
      (err: unknown) => {
        if (current) setError((err as Error).message);
      },
    );
    return () => {
      current = false;
    };
  }, [api, asked]);
  return { planners, error };
}

const plannerKey = (p: HarnessChoice): string => `${p.harness}:${p.provider}`;

/**
 * What runs: a template's agent and its model, or the workflow: a planning agent on any model
 * API (no template: it gets no tool), and any template for its script. A custom LLM endpoint is
 * asked for its models when the agent or the workflow's script uses it.
 */
function useAgentChoice(api: Api, templates: LaunchTemplate[], defaults: LaunchDefaults) {
  const [selection, setSelection] = useState(
    () => defaults.templateId ?? templates.find((t) => t.harnesses.length > 0)?.id ?? WORKFLOW,
  );
  const workflow = selection === WORKFLOW;
  const [executorTemplateId, setExecutorTemplateId] = useState(() => firstId(templates));
  const templateId = workflow ? executorTemplateId : selection;
  const template = templates.find((t) => t.id === templateId);
  const [harness, setHarness] = useState(
    defaults.harness ?? template?.harnesses[0]?.harness ?? 'claude-code',
  );
  const planners = usePlanners(api, workflow);
  const [plannerChoice, setPlannerKey] = useState('');
  const planner = workflow
    ? (planners.planners?.find((p) => plannerKey(p) === plannerChoice) ?? planners.planners?.[0])
    : undefined;
  const choice = workflow
    ? planner
    : (template?.harnesses.find((h) => h.harness === harness) ?? template?.harnesses[0]);
  const [model, setModel] = useState(defaults.model);
  const executor = workflow ? (template?.workflow.executor ?? undefined) : undefined;
  const [executorModel, setExecutorModel] = useState('');
  // A planner's choice already holds the models its endpoints list.
  const endpoint = useEndpointModels(api, templateId, !workflow && choice?.provider === 'custom');
  const executorEndpoint = useEndpointModels(api, templateId, executor !== undefined);
  return {
    selection,
    setSelection,
    workflow,
    templateId,
    setExecutorTemplateId,
    template,
    harness,
    setHarness,
    planners,
    setPlannerKey,
    choice,
    model,
    setModel,
    executor,
    executorModel,
    setExecutorModel,
    endpoint,
    executorEndpoint,
  };
}

type AgentChoice = ReturnType<typeof useAgentChoice>;

/** The agent of the template. */
function AgentSelect({ agent, onPicked }: { agent: AgentChoice; onPicked: () => void }) {
  return (
    <Field label="Agent">
      <Select
        value={agent.choice?.harness ?? agent.harness}
        onChange={(e) => {
          agent.setHarness(e.target.value as typeof agent.harness);
          onPicked();
        }}
      >
        {(agent.template?.harnesses ?? []).map((h) => (
          <option key={h.harness} value={h.harness}>
            {HARNESS_LABELS[h.harness]} ({h.provider})
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** A numbered step of the workflow, framed. */
function StepFrame({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3">
      <legend className="px-1 text-sm font-semibold text-slate-800">{title}</legend>
      <p className="text-xs text-slate-500">{hint}</p>
      {children}
    </fieldset>
  );
}

/** Step 1: the planning agent and its model, from any model API (no permission template). */
function PlanStep({ agent }: { agent: AgentChoice }) {
  const { planners } = agent.planners;
  let picker: ReactNode;
  if (agent.planners.error) {
    picker = <ErrorBanner message={agent.planners.error} />;
  } else if (!planners) {
    picker = <p className="text-sm text-slate-500">Loading the planning agents…</p>;
  } else {
    picker = (
      <Field label="Planning agent">
        <Select
          value={agent.choice ? plannerKey(agent.choice) : ''}
          onChange={(e) => {
            agent.setPlannerKey(e.target.value);
            agent.setModel('');
          }}
        >
          {planners.map((p) => (
            <option key={plannerKey(p)} value={plannerKey(p)}>
              {HARNESS_LABELS[p.harness]} · {p.provider}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  return (
    <StepFrame
      title="1 · Plan"
      hint="A frontier model writes a script for the task. It gets no tool, so no permissions are involved: pick any agent and model you have access to."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {picker}
        <ModelField
          label="Planning model"
          choice={agent.choice}
          endpoint={null}
          model={agent.model}
          setModel={agent.setModel}
        />
      </div>
    </StepFrame>
  );
}

/** Step 2: the permissions the script runs with, and its custom LLM endpoint's model if any. */
function ExecuteStep({ agent, templates }: { agent: AgentChoice; templates: LaunchTemplate[] }) {
  const { template, executor } = agent;
  return (
    <StepFrame
      title="2 · Execute"
      hint="The script runs on its own, with the tools of the permissions you pick and, if they give one, their custom LLM endpoint. No frontier model API."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Permissions" hint={templateHint(template)}>
          <Select
            value={agent.templateId}
            onChange={(e) => {
              agent.setExecutorTemplateId(e.target.value);
              agent.setExecutorModel('');
            }}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        {executor ? (
          <ModelField
            label="Script model (custom LLM endpoint)"
            choice={executor}
            endpoint={agent.executorEndpoint}
            model={agent.executorModel}
            setModel={agent.setExecutorModel}
          />
        ) : (
          <p className="self-end text-xs text-slate-500">
            No custom LLM endpoint: the script has the tools only.
          </p>
        )}
      </div>
    </StepFrame>
  );
}

/** The template's tools and key lifetime, under its select. */
const templateHint = (template: LaunchTemplate | undefined): string | undefined =>
  template &&
  `${template.tools.join(', ')} · keys last up to ${formatDuration(template.maxTtlSeconds)}`;

/** What runs: a template's agent and model, or the workflow's two steps. */
function AgentFields({
  agent,
  templates,
  once,
}: {
  agent: AgentChoice;
  templates: LaunchTemplate[];
  /** Chained and relaunched agents, and edited triggers, can't be a workflow. */
  once: boolean;
}) {
  const { workflow, setModel } = agent;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={workflow ? 'Run' : 'Permissions'}
          hint={workflow ? undefined : templateHint(agent.template)}
        >
          <TemplateSelect
            templates={templates}
            value={agent.selection}
            withWorkflow={!once}
            onChange={(value) => {
              agent.setSelection(value);
              setModel('');
              agent.setExecutorModel('');
            }}
          />
        </Field>
        {!workflow && (
          <AgentSelect
            agent={agent}
            onPicked={() => {
              setModel('');
            }}
          />
        )}
      </div>
      {workflow ? (
        <>
          <PlanStep agent={agent} />
          <ExecuteStep agent={agent} templates={templates} />
        </>
      ) : (
        <ModelField
          choice={agent.choice}
          endpoint={agent.endpoint}
          model={agent.model}
          setModel={setModel}
        />
      )}
    </>
  );
}

const DEFAULT_ENVIRONMENT_HINT = 'The standard agent VM: Node 22, git, Python and the agent CLIs.';

/** The guest environment the agent's VM boots: the default one, or one the admin added. */
function EnvironmentField({
  environments,
  value,
  onChange,
}: {
  environments: EnvironmentChoice[];
  value: string;
  onChange: (value: string) => void;
}) {
  if (environments.length === 0) return null;
  const picked = environments.find((e) => e.id === value);
  return (
    <Field label="Environment" hint={picked ? picked.description : DEFAULT_ENVIRONMENT_HINT}>
      <Select
        value={picked ? value : ''}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        <option value="">Default</option>
        {environments.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** What an agent (not a workflow) starts with: its environment and skills. */
function AgentSetupFields({
  shown,
  options,
  environmentId,
  setEnvironmentId,
  skills,
  setSkills,
}: {
  shown: boolean;
  options: LaunchOptions;
  environmentId: string;
  setEnvironmentId: (value: string) => void;
  skills: string[];
  setSkills: (value: string[]) => void;
}) {
  if (!shown) return null;
  return (
    <>
      <EnvironmentField
        environments={options.environments}
        value={environmentId}
        onChange={setEnvironmentId}
      />
      <SkillsField skills={options.skills} value={skills} onChange={setSkills} />
    </>
  );
}

function SubmitRow({
  timeoutSeconds,
  label,
  disabled,
}: {
  timeoutSeconds: number;
  label: string;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-xs text-slate-500">
        Runs in a disposable VM that can only reach the gateway. Stops after{' '}
        {formatDuration(timeoutSeconds)} at most.
      </p>
      <Button type="submit" disabled={disabled}>
        {label}
      </Button>
    </div>
  );
}

/**
 * Tools of the template (and a workflow planner's model API) for which the member has several
 * accounts: they pick one.
 */
function useAccountPicks(
  accounts: Account[],
  template: LaunchTemplate | undefined,
  plannerTool: string | undefined,
  initial: Record<string, string>,
) {
  const [picked, setPicked] = useState<Record<string, string>>(initial);
  const ambiguous = [
    ...new Set([...(template?.tools ?? []), ...(plannerTool ? [plannerTool] : [])]),
  ]
    .map((tool) => ({ tool, options: accounts.filter((a) => a.tool === tool) }))
    .filter((x) => x.options.length > 1);
  const pickedFor = (tools: readonly string[]): string[] =>
    ambiguous
      .filter((x) => tools.includes(x.tool))
      .map((x) => picked[x.tool] ?? x.options[0]?.id ?? '')
      .filter(Boolean);
  return { ambiguous, picked, setPicked, pickedFor };
}

/** Run once now, on a schedule, or on webhook events. */
function WhenField({ when, setWhen }: { when: When; setWhen: (when: When) => void }) {
  return (
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
  );
}

const PARENT_PROMPT_PREVIEW = 200;

/** What a chained agent starts from: the run it is chained after, and where its files go. */
function ChainNote({ parent }: { parent: Run }) {
  const task = parent.instructions ?? parent.prompt;
  return (
    <div className="rounded-lg bg-indigo-50 p-3 text-sm text-slate-700 ring-1 ring-indigo-200">
      <p className="font-medium text-slate-800">
        Chained after a {HARNESS_LABELS[parent.harness]} run
      </p>
      <p className="mt-1 truncate text-xs text-slate-600" title={task}>
        {task.slice(0, PARENT_PROMPT_PREVIEW)}
      </p>
      <p className="mt-1 text-xs text-slate-600">
        The new agent finds that run&apos;s output files in /home/agent/in. Tell it what to do with
        them.
      </p>
    </div>
  );
}

/**
 * The environment a chained agent starts with: the one its parent ran in, if members can still
 * launch in it ('' = the default one).
 */
function parentEnvironment(parent: Run | null, environments: EnvironmentChoice[]): string {
  const id = parent?.environmentId;
  return id && environments.some((e) => e.id === id) ? id : '';
}

/** The tools for which the member has several accounts: they pick one. */
function AccountFields({
  ambiguous,
  picked,
  setPicked,
}: {
  ambiguous: { tool: string; options: Account[] }[];
  picked: Record<string, string>;
  setPicked: (picked: Record<string, string>) => void;
}) {
  return ambiguous.map((x) => (
    <Field
      key={x.tool}
      label={
        x.options[0]?.kind === 'llm' ? `Model provider account (${x.tool})` : `${x.tool} account`
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
  ));
}

/** The task, or a trigger's instructions, and a relaunched triggered run's instructions. */
function useTask(defaults: LaunchDefaults) {
  const [prompt, setPrompt] = useState(defaults.prompt);
  const [instructions, setInstructions] = useState(defaults.instructions ?? '');
  const event = defaults.instructions !== null;
  return {
    prompt,
    setPrompt,
    instructions,
    setInstructions,
    event,
    /** The instructions sent: a relaunched triggered run's only. */
    sent: event ? instructions : '',
  };
}

/** What a relaunch keeps of its run's input files (all of them, unless the member unticks). */
function useRelaunchInputs(relaunch: Relaunch | null) {
  const [inputs, setInputs] = useState<RelaunchInputs>({
    keepParent: true,
    keepAttachments: true,
  });
  const parentRunId = relaunch?.run.parentRunId ?? null;
  return {
    inputs,
    setInputs,
    parentRunId: parentRunId !== null && inputs.keepParent ? parentRunId : '',
    attachmentsFrom:
      relaunch && inputs.keepAttachments && relaunch.attachments.length > 0 ? relaunch.run.id : '',
  };
}

/**
 * What the form starts from: a relaunched run's or an edited trigger's settings, or blank (a chained agent's environment). */
function launchDefaults(
  relaunch: Relaunch | null,
  parent: Run | null,
  editing: Trigger | null,
  options: LaunchOptions,
  accounts: Account[],
): LaunchDefaults {
  if (relaunch) return relaunchDefaults(relaunch.run, options, accounts);
  if (editing) return triggerDefaults(editing, options, accounts);
  return { ...BLANK_DEFAULTS, environmentId: parentEnvironment(parent, options.environments) };
}

const taskKind = (event: boolean, trigger: boolean): TaskKind => {
  if (event) return 'event';
  return trigger ? 'trigger' : 'task';
};

function submitLabel(workflow: boolean, relaunching: boolean, editing: boolean, when: When) {
  if (workflow) return 'Launch workflow';
  if (editing) return 'Save trigger';
  return relaunching ? 'Relaunch agent' : SUBMIT_LABELS[when];
}

/**
 * Workflows, chained and relaunched agents run once, now (`single`). An edited trigger stays one.
 * Neither can be a workflow, nor run at another time (`fixed`).
 */
function formMode(parent: Run | null, relaunch: Relaunch | null, editing: Trigger | null) {
  const single = parent !== null || relaunch !== null;
  return { single, fixed: single || editing !== null };
}

/** What an edited trigger listens to, or a new trigger's defaults. */
function useTriggerFields(editing: Trigger | null, webhooks: WebhookOption[]) {
  const [name, setName] = useState(editing?.name ?? '');
  const [webhookId, setWebhookId] = useState(() =>
    editing && webhooks.some((w) => w.id === editing.webhookId)
      ? editing.webhookId
      : firstId(webhooks),
  );
  const [eventTypes, setEventTypes] = useState(editing?.eventTypes.join(', ') ?? '');
  const [filters, setFilters] = useState(editing ? toDraft(editing.filters) : NO_FILTERS);
  return {
    editing: editing !== null,
    /** Saved with `PUT`, instead of created. */
    triggerId: editing?.id ?? null,
    method: editing ? 'PUT' : 'POST',
    initialWhen: (editing ? 'webhook' : 'now') as When,
    name,
    setName,
    webhookId,
    setWebhookId,
    eventTypes,
    setEventTypes,
    filters,
    setFilters,
  };
}

/** The trigger's name, when editing one. */
function NameField({
  shown,
  name,
  setName,
}: {
  shown: boolean;
  name: string;
  setName: (v: string) => void;
}) {
  if (!shown) return null;
  return (
    <Field label="Name" hint="Empty: keep the current name.">
      <Input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
        }}
      />
    </Field>
  );
}

/**
 * Launch an agent now, schedule it, or trigger it on webhook events; relaunch a run, or edit a
 * trigger.
 */
export function LaunchForm({
  api,
  options,
  accounts,
  webhooks,
  onLaunched,
  onScheduled,
  onTriggered,
  onWorkflow,
  parent = null,
  relaunch = null,
  editing = null,
}: {
  api: Api;
  options: LaunchOptions;
  accounts: Account[];
  /** The member's webhooks, for triggers. */
  webhooks: WebhookOption[];
  onLaunched: (run: Run) => void;
  onScheduled: (schedule: Schedule) => void;
  onTriggered: (trigger: Trigger) => void;
  onWorkflow: (workflow: Workflow) => void;
  /** The run to chain the agent after: it starts from its output files, once, now. */
  parent?: Run | null;
  /** The run to launch again, its settings filled in to edit: once, now. */
  relaunch?: Relaunch | null;
  /** The trigger to edit, its settings filled in: saved instead of creating a new one. */
  editing?: Trigger | null;
}) {
  const { templates } = options;
  const [defaults] = useState(() => launchDefaults(relaunch, parent, editing, options, accounts));
  const task = useTask(defaults);
  const { prompt } = task;
  const agent = useAgentChoice(api, templates, defaults);
  const { workflow, templateId, template, harness, choice, model, executor, executorModel } = agent;
  const trigger = useTriggerFields(editing, webhooks);
  const { webhookId, eventTypes, filters } = trigger;
  const [chosenWhen, setWhen] = useState<When>(trigger.initialWhen);
  const { single, fixed } = formMode(parent, relaunch, editing);
  const once = workflow || single;
  const when: When = once ? 'now' : chosenWhen;
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState(1);
  const [day, setDay] = useState(1);
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [environmentId, setEnvironmentId] = useState(defaults.environmentId);
  const [skills, setSkills] = useState<string[]>(defaults.skills);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const relaunched = useRelaunchInputs(relaunch);
  const attaching = attachable(when, workflow);

  const plannerTool = workflow ? choice?.provider : undefined;
  const { ambiguous, picked, setPicked, pickedFor } = useAccountPicks(
    accounts,
    template,
    plannerTool,
    defaults.picked,
  );

  if (!templates.some((t) => t.harnesses.length > 0)) {
    return (
      <p className="text-sm text-slate-600">
        None of your templates gives access to a model API (Anthropic, OpenAI, Gemini or a custom
        LLM endpoint), which agents need. Ask the gateway admin.
      </p>
    );
  }

  const send = async (attachmentIds: string[]): Promise<void> => {
    const request = requestFor({
      when,
      triggerId: trigger.triggerId,
      name: trigger.name,
      workflow,
      executorModel: executorModel.trim(),
      plannerProvider: plannerTool ?? '',
      plannerAccountIds: plannerTool ? pickedFor([plannerTool]) : [],
      prompt,
      templateId,
      harness: choice?.harness ?? harness,
      accountIds: pickedFor(template?.tools ?? []),
      model: model.trim(),
      environmentId: workflow ? '' : environmentId,
      skills,
      time,
      weekday,
      day,
      timezone,
      webhookId,
      eventTypes,
      filters,
      parentRunId: parent?.id ?? relaunched.parentRunId,
      attachmentIds,
      instructions: task.sent,
      attachmentsFrom: relaunched.attachmentsFrom,
    });
    const sent = await api<Run | Schedule | Trigger | Workflow>(
      trigger.method,
      request.path,
      request.body,
    ).catch(async (err: unknown) => {
      // Not launched with: they would only wait to be deleted.
      await discardAttachments(api, attachmentIds);
      throw err;
    });
    if (workflow) onWorkflow(sent as Workflow);
    else if (when === 'now') onLaunched(sent as Run);
    else if (when === 'webhook') onTriggered(sent as Trigger);
    else onScheduled(sent as Schedule);
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const attachmentIds = attaching ? await uploadAttachments(api, files, setUploading) : [];
      setUploading(null);
      await send(attachmentIds);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(null);
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
      {parent && <ChainNote parent={parent} />}
      {relaunch && (
        <RelaunchNote
          relaunch={relaunch}
          options={options}
          inputs={relaunched.inputs}
          setInputs={relaunched.setInputs}
        />
      )}
      <NameField shown={trigger.editing} name={trigger.name} setName={trigger.setName} />
      <InstructionsField
        shown={task.event}
        instructions={task.instructions}
        setInstructions={task.setInstructions}
      />
      <TaskField
        kind={taskKind(task.event, !workflow && when === 'webhook')}
        prompt={prompt}
        setPrompt={task.setPrompt}
      />
      <AgentFields agent={agent} templates={templates} once={fixed} />
      <AgentSetupFields
        shown={!workflow}
        options={options}
        environmentId={environmentId}
        setEnvironmentId={setEnvironmentId}
        skills={skills}
        setSkills={setSkills}
      />
      <AccountFields ambiguous={ambiguous} picked={picked} setPicked={setPicked} />
      {!(workflow || fixed) && <WhenField when={when} setWhen={setWhen} />}
      <AttachmentsField shown={attaching} files={files} onChange={setFiles} progress={uploading} />
      {when === 'webhook' && (
        <TriggerFields
          webhooks={webhooks}
          webhookId={webhookId}
          setWebhookId={trigger.setWebhookId}
          eventTypes={eventTypes}
          setEventTypes={trigger.setEventTypes}
          filters={filters}
          setFilters={trigger.setFilters}
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
      <SubmitRow
        timeoutSeconds={options.defaultTimeoutSeconds}
        label={submitLabel(workflow, relaunch !== null, trigger.editing, when)}
        disabled={
          busy ||
          // A workflow waits for its planning agents.
          (workflow && !choice) ||
          !complete({ when, prompt, webhookId, choice, model, executor, executorModel })
        }
      />
    </form>
  );
}
