// Shapes returned by the launchpad API (see src/server/launchpad/routes.ts).
import type { ActivityEntry } from './types';

export type Harness = 'claude-code' | 'codex' | 'gemini' | 'pi';
export type RunStatus =
  'queued' | 'provisioning' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';

export const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'provisioning', 'running'];
export const isActive = (status: RunStatus): boolean => ACTIVE_STATUSES.includes(status);

export const HARNESS_LABELS: Record<Harness, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  pi: 'pi',
};

export interface Run {
  id: string;
  memberId: string;
  memberName: string;
  scheduleId: string | null;
  triggerId: string | null;
  harness: Harness;
  model: string | null;
  prompt: string;
  /** A webhook trigger's instructions (the prompt is then the event). */
  instructions: string | null;
  templateId: string;
  templateName: string;
  status: RunStatus;
  statusReason: string | null;
  timeoutSeconds: number;
  tokenBudget: number | null;
  tokensUsed: number;
  memoryIn: string | null;
  memoryOut: string | null;
  finalMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  deadline: string | null;
  finishedAt: string | null;
  outputsBytes: number;
}

export type RunEventType =
  | 'status'
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'usage'
  | 'log'
  | 'error'
  | 'final';

export interface RunEvent {
  seq: number;
  at: string;
  type: RunEventType;
  text: string;
  tool?: string;
  callId?: string;
  data: unknown;
}

export interface OutputFile {
  path: string;
  size: number;
  createdAt: string;
  expiresAt: string;
}

export interface ModelUsage {
  provider: string;
  model: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface HarnessChoice {
  harness: Harness;
  provider: string;
  models: string[];
}

export interface LaunchTemplate {
  id: string;
  name: string;
  description: string;
  tools: string[];
  maxTtlSeconds: number;
  harnesses: HarnessChoice[];
}

export interface LaunchOptions {
  enabled: boolean;
  driver: string;
  defaultTimeoutSeconds: number;
  templates: LaunchTemplate[];
}

export type Preset = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface Schedule {
  id: string;
  memberId: string;
  memberName: string;
  name: string;
  prompt: string;
  harness: Harness;
  model: string | null;
  templateId: string;
  preset: Preset;
  minute: number;
  hour: number;
  weekday: number;
  dayOfMonth: number;
  timezone: string;
  enabled: boolean;
  stoppedReason: string | null;
  memory: string | null;
  nextRunAt: string | null;
  nextRuns: string[];
  lastRunId: string | null;
}

/** An agent launched by every matching delivery on one of the member's webhooks. */
export interface Trigger {
  id: string;
  memberId: string;
  memberName: string;
  name: string;
  webhookId: string;
  /** Null once the webhook is deleted. */
  webhookName: string | null;
  eventTypes: string[];
  instructions: string;
  harness: Harness;
  model: string | null;
  templateId: string;
  enabled: boolean;
  stoppedReason: string | null;
  lastRunId: string | null;
  lastFiredAt: string | null;
}

/** A webhook a trigger can listen to (see `GET /webhooks`). */
export interface WebhookOption {
  id: string;
  name: string;
  source: string;
}

export interface LaunchSettings {
  maxConcurrentRuns: number;
  maxConcurrentPerMember: number;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  tokenBudgetPerRun: number;
  vcpus: number;
  memMib: number;
  outputRetentionDays: number;
}

export interface MemberLaunch {
  memberId: string;
  name: string;
  launchEnabled: boolean;
  maxConcurrent: number | null;
  activeRuns: number;
}

export type RunActivity = ActivityEntry;

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const pad = (n: number): string => String(n).padStart(2, '0');

/** "Daily at 09:00 (Europe/Paris)" */
export function describeSchedule(
  s: Pick<Schedule, 'preset' | 'minute' | 'hour' | 'weekday' | 'dayOfMonth' | 'timezone'>,
): string {
  const time = `${pad(s.hour)}:${pad(s.minute)}`;
  const when: Record<Preset, string> = {
    hourly: `Hourly at :${pad(s.minute)}`,
    daily: `Daily at ${time}`,
    weekly: `${WEEKDAYS[s.weekday] ?? ''}s at ${time}`,
    monthly: `Monthly on day ${s.dayOfMonth} at ${time}`,
  };
  return `${when[s.preset]} (${s.timezone})`;
}

const THOUSAND = 1000;
const MILLION = THOUSAND * THOUSAND;

/** 1234567 → "1.2M" */
export function formatTokens(n: number): string {
  if (n >= MILLION) return `${(n / MILLION).toFixed(1)}M`;
  if (n >= THOUSAND) return `${(n / THOUSAND).toFixed(1)}k`;
  return String(n);
}

const KIB = 1024;

export function formatBytes(n: number): string {
  if (n >= KIB * KIB) return `${(n / KIB / KIB).toFixed(1)} MB`;
  if (n >= KIB) return `${(n / KIB).toFixed(1)} kB`;
  return `${n} B`;
}

/** `mcp__gateway__gateway_github` (as harnesses name MCP tools) → `github`. */
export function toolLabel(name: string): string {
  return name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^gateway_/, '');
}

/** Same, inside a tool call summary that starts with the tool's name. */
export function withToolLabel(text: string, tool: string | undefined): string {
  return tool && text.startsWith(tool) ? `${toolLabel(tool)}${text.slice(tool.length)}` : text;
}
