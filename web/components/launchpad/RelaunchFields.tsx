'use client';

import {
  type Attachment,
  HARNESS_LABELS,
  type Harness,
  type LaunchOptions,
  type Run,
  type RunHarness,
  type Trigger,
} from '@/lib/launchpad';
import type { Account } from '@/lib/types';
import { Field, Textarea } from '../ui';

/** A run to launch again, its settings edited: and the files that were attached to it. */
export interface Relaunch {
  run: Run;
  attachments: Attachment[];
}

/** Whether a run can be relaunched from its page: a finished agent run, not a workflow step. */
export const relaunchable = (run: Run): boolean =>
  run.harness !== 'script' && run.workflowId === null;

/** What the launch form starts from: blank, or a relaunched run's settings that still apply. */
export interface LaunchDefaults {
  prompt: string;
  /** A webhook-triggered run's instructions (null: the run had none). */
  instructions: string | null;
  templateId: string | null;
  harness: Harness | null;
  model: string;
  environmentId: string;
  skills: string[];
  /** The account picked for each tool, by tool. */
  picked: Record<string, string>;
}

export const BLANK_DEFAULTS: LaunchDefaults = {
  prompt: '',
  instructions: null,
  templateId: null,
  harness: null,
  model: '',
  environmentId: '',
  skills: [],
  picked: {},
};

/** What a run or a trigger was launched with, to fill in the form again. */
interface AgentSettings {
  templateId: string;
  harness: RunHarness;
  model: string | null;
  environmentId: string | null;
  skills: string[];
  accountIds: string[];
}

/**
 * A run's or a trigger's settings, as far as the member can still launch with them: its template,
 * agent and model if the template (as configured now) still gives them, its environment and skills
 * if they are still offered, and the accounts it used.
 */
function settingsDefaults(
  settings: AgentSettings,
  options: LaunchOptions,
  accounts: Account[],
): Omit<LaunchDefaults, 'prompt' | 'instructions'> {
  const template = options.templates.find(
    (t) => t.id === settings.templateId && t.harnesses.length > 0,
  );
  const choice = template?.harnesses.find((h) => h.harness === settings.harness);
  // A custom endpoint serves models the template doesn't list: the gateway checks them.
  const modelKept =
    choice !== undefined &&
    settings.model !== null &&
    (choice.provider === 'custom' || choice.models.includes(settings.model));
  const skills = new Set(options.skills.map((s) => s.name));
  const picked: Record<string, string> = {};
  for (const id of settings.accountIds) {
    const account = accounts.find((a) => a.id === id);
    if (account) picked[account.tool] = id;
  }
  return {
    templateId: template?.id ?? null,
    harness: choice ? (choice.harness as Harness) : null,
    model: modelKept ? (settings.model ?? '') : '',
    environmentId:
      settings.environmentId && options.environments.some((e) => e.id === settings.environmentId)
        ? settings.environmentId
        : '',
    skills: settings.skills.filter((s) => skills.has(s)),
    picked,
  };
}

/** A relaunched run's settings that still apply, its task and its instructions. */
export function relaunchDefaults(
  run: Run,
  options: LaunchOptions,
  accounts: Account[],
): LaunchDefaults {
  return {
    prompt: run.prompt,
    instructions: run.instructions,
    ...settingsDefaults(run, options, accounts),
  };
}

/** An edited trigger's settings that still apply: its instructions are the form's task. */
export function triggerDefaults(
  trigger: Trigger,
  options: LaunchOptions,
  accounts: Account[],
): LaunchDefaults {
  return {
    prompt: trigger.instructions,
    instructions: null,
    ...settingsDefaults(trigger, options, accounts),
  };
}

/** What carries over from the relaunched run besides its settings: its input files. */
export interface RelaunchInputs {
  keepParent: boolean;
  keepAttachments: boolean;
}

function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: string;
}) {
  return (
    <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-slate-700">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />
      <span>{children}</span>
    </label>
  );
}

/**
 * What the relaunch starts from: the run, what of it no longer applies, and whether the new run
 * gets its input files again.
 */
export function RelaunchNote({
  relaunch,
  options,
  inputs,
  setInputs,
}: {
  relaunch: Relaunch;
  options: LaunchOptions;
  inputs: RelaunchInputs;
  setInputs: (inputs: RelaunchInputs) => void;
}) {
  const { run, attachments } = relaunch;
  const defaults = relaunchDefaults(run, options, []);
  const lost = [
    ...(defaults.templateId === null ? [`the permissions “${run.templateName}”`] : []),
    ...(defaults.templateId !== null && defaults.harness === null
      ? [HARNESS_LABELS[run.harness]]
      : []),
    ...(run.environmentName && !defaults.environmentId ? [run.environmentName] : []),
    ...run.skills.filter((s) => !defaults.skills.includes(s)).map((s) => `the skill ${s}`),
  ];
  return (
    <div className="rounded-lg bg-indigo-50 p-3 text-sm text-slate-700 ring-1 ring-indigo-200">
      <p className="font-medium text-slate-800">Relaunching a {HARNESS_LABELS[run.harness]} run</p>
      <p className="mt-1 text-xs text-slate-600">
        Its settings are filled in, with the permissions as they are configured now. Change what you
        need: a new agent runs once, now.
      </p>
      {lost.length > 0 && (
        <p className="mt-1 text-xs text-amber-700">
          No longer available to you: {lost.join(', ')}. Pick something else.
        </p>
      )}
      {run.parentRunId !== null && (
        <Toggle
          checked={inputs.keepParent}
          onChange={(keepParent) => {
            setInputs({ ...inputs, keepParent });
          }}
        >
          Chained: start from the output files of the run it was chained after again
        </Toggle>
      )}
      {attachments.length > 0 && (
        <Toggle
          checked={inputs.keepAttachments}
          onChange={(keepAttachments) => {
            setInputs({ ...inputs, keepAttachments });
          }}
        >
          {`Attach its files again (${attachments.map((a) => a.name).join(', ')}); a file you attach below replaces one of the same name`}
        </Toggle>
      )}
    </div>
  );
}

/** A relaunched webhook-triggered run's instructions: they go in the agent's system prompt. */
export function InstructionsField({
  shown,
  instructions,
  setInstructions,
}: {
  shown: boolean;
  instructions: string;
  setInstructions: (v: string) => void;
}) {
  if (!shown) return null;
  return (
    <Field
      label="Instructions"
      hint="The trigger's instructions, in the agent's system prompt. The webhook event below is its task."
    >
      <Textarea
        rows={4}
        value={instructions}
        onChange={(e) => {
          setInstructions(e.target.value);
        }}
        className="font-sans"
      />
    </Field>
  );
}
