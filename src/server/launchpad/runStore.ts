import type { Database } from '../db/database.js';
import { MS_PER_DAY, SECONDS_PER_HOUR } from '../units.js';
import { redact, redactDeep } from '../db/redact.js';
import {
  type Harness,
  type LlmProvider,
  type RunEvent,
  type RunEventType,
  type RunHarness,
  RUNNER_LIMITS,
} from './protocol.js';

/** Chunks of an upload that never completed are kept this long after their run finished. */
const ABANDONED_UPLOAD_MS = MS_PER_DAY;

export const RUN_STATUSES = [
  'queued',
  'provisioning',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_STATUSES: readonly RunStatus[] = ['queued', 'provisioning', 'running'];
export const isActive = (status: RunStatus): boolean => ACTIVE_STATUSES.includes(status);

/** Steps of a workflow, in order: a frontier agent writes a script, the execution container runs it. */
export const WORKFLOW_STEPS = ['plan', 'execute'] as const;
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export interface Run {
  id: string;
  memberId: string;
  memberName: string;
  scheduleId: string | null;
  /** The webhook trigger that launched the run, if any. */
  triggerId: string | null;
  /** The workflow the run is a step of, and which step, if any. */
  workflowId: string | null;
  workflowStep: WorkflowStep | null;
  /** The run whose output files this one started from (chained runs), if any. */
  parentRunId: string | null;
  harness: RunHarness;
  model: string | null;
  prompt: string;
  /** A trigger's instructions, added to the system prompt (the prompt is then the event). */
  instructions: string | null;
  templateId: string;
  templateName: string;
  accountIds: string[];
  /** The guest environment the VM boots (null: the default guest image). */
  environmentId: string | null;
  environmentName: string | null;
  sessionId: string | null;
  vmId: string | null;
  status: RunStatus;
  statusReason: string | null;
  timeoutSeconds: number;
  tokenBudget: number | null;
  /** Member key generation recorded by the schedule that launched the run, if any. */
  keyGeneration: number | null;
  memoryIn: string | null;
  memoryOut: string | null;
  finalMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  deadline: string | null;
  finishedAt: string | null;
  outputsBytes: number;
}

export type NewRun = Pick<
  Run,
  | 'id'
  | 'memberId'
  | 'memberName'
  | 'scheduleId'
  | 'triggerId'
  | 'workflowId'
  | 'workflowStep'
  | 'parentRunId'
  | 'harness'
  | 'model'
  | 'prompt'
  | 'instructions'
  | 'templateId'
  | 'templateName'
  | 'accountIds'
  | 'environmentId'
  | 'environmentName'
  | 'timeoutSeconds'
  | 'tokenBudget'
  | 'keyGeneration'
  | 'memoryIn'
  | 'createdAt'
>;

/**
 * A multi-step workflow: a frontier agent (`plannerHarness`) writes a script for the task, then the
 * execution container runs it with the template's tools and, if it gives one, its custom LLM
 * endpoint (`executorModel`). The planner may be any agent and model API the member can launch:
 * it runs on `plannerTemplateId`, the template that gives that API, with no tools. Its status
 * comes from its step runs.
 */
export interface Workflow {
  id: string;
  memberId: string;
  memberName: string;
  prompt: string;
  templateId: string;
  templateName: string;
  /** The accounts the script uses. */
  accountIds: string[];
  /** The template whose model API the planner uses. */
  plannerTemplateId: string;
  plannerTemplateName: string;
  plannerHarness: Harness;
  /** The model API the planner uses (null for workflows created before it was recorded). */
  plannerProvider: LlmProvider | null;
  plannerModel: string | null;
  /** Null: the template gives no custom LLM endpoint, and the script has no LLM. */
  executorModel: string | null;
  /** Why the workflow stopped between steps (e.g. the planner wrote no script), or null. */
  failure: string | null;
  createdAt: string;
}

export type NewWorkflow = Omit<Workflow, 'failure'>;

interface WorkflowRow {
  id: string;
  member_id: string;
  member_name: string;
  prompt: string;
  template_id: string;
  template_name: string;
  account_ids: string;
  planner_template_id: string | null;
  planner_template_name: string | null;
  planner_harness: Harness;
  planner_provider: LlmProvider | null;
  planner_model: string | null;
  /** '' when the script has no LLM. */
  executor_model: string;
  failure: string | null;
  created_at: string;
}

function toWorkflow(r: WorkflowRow): Workflow {
  return {
    id: r.id,
    memberId: r.member_id,
    memberName: r.member_name,
    prompt: r.prompt,
    templateId: r.template_id,
    templateName: r.template_name,
    accountIds: JSON.parse(r.account_ids) as string[],
    plannerTemplateId: r.planner_template_id ?? r.template_id,
    plannerTemplateName: r.planner_template_name ?? r.template_name,
    plannerHarness: r.planner_harness,
    plannerProvider: r.planner_provider,
    plannerModel: r.planner_model,
    executorModel: r.executor_model || null,
    failure: r.failure,
    createdAt: r.created_at,
  };
}

export interface StoredEvent extends Omit<RunEvent, 'data'> {
  data: unknown;
}

export interface OutputFile {
  path: string;
  size: number;
  createdAt: string;
  expiresAt: string;
}

export interface RunFilter {
  memberId?: string;
  status?: RunStatus;
  scheduleId?: string;
  triggerId?: string;
  workflowId?: string;
  /** Runs chained after this one. */
  parentRunId?: string;
  harness?: RunHarness;
  /** Runs created before this ISO time (paging, newest first). */
  before?: string;
  limit?: number;
}

/** Instance-wide launchpad settings, editable by the admin. */
export interface LaunchSettings {
  maxConcurrentRuns: number;
  maxConcurrentPerMember: number;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  /** Token budget of each run's session key (input + output + cache tokens). */
  tokenBudgetPerRun: number;
  vcpus: number;
  memMib: number;
  /** Output files are deleted after this many days; transcripts are kept. */
  outputRetentionDays: number;
}

const DEFAULT_TIMEOUT_HOURS = 2;
const MAX_TIMEOUT_HOURS = 4;
export const DEFAULT_SETTINGS: LaunchSettings = {
  maxConcurrentRuns: 8,
  maxConcurrentPerMember: 2,
  defaultTimeoutSeconds: DEFAULT_TIMEOUT_HOURS * SECONDS_PER_HOUR,
  maxTimeoutSeconds: MAX_TIMEOUT_HOURS * SECONDS_PER_HOUR,
  tokenBudgetPerRun: 20_000_000,
  vcpus: 1,
  memMib: 1024,
  outputRetentionDays: 30,
};

export interface MemberLaunch {
  memberId: string;
  launchEnabled: boolean;
  /** Overrides `maxConcurrentPerMember`; null = the default. */
  maxConcurrent: number | null;
}

interface RunRow {
  id: string;
  member_id: string;
  member_name: string;
  schedule_id: string | null;
  trigger_id: string | null;
  workflow_id: string | null;
  workflow_step: WorkflowStep | null;
  parent_run_id: string | null;
  harness: RunHarness;
  model: string | null;
  prompt: string;
  instructions: string | null;
  template_id: string;
  template_name: string;
  account_ids: string;
  environment_id: string | null;
  environment_name: string | null;
  session_id: string | null;
  vm_id: string | null;
  status: RunStatus;
  status_reason: string | null;
  timeout_seconds: number;
  token_budget: number | null;
  key_generation: number | null;
  memory_in: string | null;
  memory_out: string | null;
  final_message: string | null;
  created_at: string;
  started_at: string | null;
  deadline: string | null;
  finished_at: string | null;
  outputs_bytes: number;
}

interface EventRow {
  seq: number;
  at: string;
  type: RunEventType;
  text: string;
  tool: string | null;
  call_id: string | null;
  data: string | null;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const MAX_EVENTS_PAGE = 2000;
const TRUNCATED = '…[truncated]';

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    memberId: r.member_id,
    memberName: r.member_name,
    scheduleId: r.schedule_id,
    triggerId: r.trigger_id,
    workflowId: r.workflow_id,
    workflowStep: r.workflow_step,
    parentRunId: r.parent_run_id,
    harness: r.harness,
    model: r.model,
    prompt: r.prompt,
    instructions: r.instructions,
    templateId: r.template_id,
    templateName: r.template_name,
    accountIds: JSON.parse(r.account_ids) as string[],
    environmentId: r.environment_id,
    environmentName: r.environment_name,
    sessionId: r.session_id,
    vmId: r.vm_id,
    status: r.status,
    statusReason: r.status_reason,
    timeoutSeconds: r.timeout_seconds,
    tokenBudget: r.token_budget,
    keyGeneration: r.key_generation,
    memoryIn: r.memory_in,
    memoryOut: r.memory_out,
    finalMessage: r.final_message,
    createdAt: r.created_at,
    startedAt: r.started_at,
    deadline: r.deadline,
    finishedAt: r.finished_at,
    outputsBytes: r.outputs_bytes,
  };
}

const COLUMNS: Readonly<Partial<Record<string, string>>> = {
  runTokenHash: 'run_token_hash',
  sessionId: 'session_id',
  vmId: 'vm_id',
  status: 'status',
  statusReason: 'status_reason',
  memoryOut: 'memory_out',
  finalMessage: 'final_message',
  startedAt: 'started_at',
  deadline: 'deadline',
  finishedAt: 'finished_at',
};
export type RunPatch = { runTokenHash?: string } & Partial<
  Pick<
    Run,
    | 'sessionId'
    | 'vmId'
    | 'status'
    | 'statusReason'
    | 'memoryOut'
    | 'finalMessage'
    | 'startedAt'
    | 'deadline'
    | 'finishedAt'
  >
>;

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}${TRUNCATED}` : text;
}

/** Runs, transcripts, output files and launch settings, in the gateway database. */
export class RunStore {
  constructor(readonly db: Database) {}

  insert(run: NewRun): Run {
    this.db.sql
      .prepare(
        `INSERT INTO runs (id, member_id, member_name, schedule_id, trigger_id, workflow_id,
           workflow_step, parent_run_id, harness, model, prompt, instructions, template_id,
           template_name, account_ids, environment_id, environment_name, run_token_hash, status,
           timeout_seconds, token_budget, key_generation, memory_in, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.memberId,
        run.memberName,
        run.scheduleId,
        run.triggerId,
        run.workflowId,
        run.workflowStep,
        run.parentRunId,
        run.harness,
        run.model,
        redact(run.prompt),
        run.instructions === null ? null : redact(run.instructions),
        run.templateId,
        run.templateName,
        JSON.stringify(run.accountIds),
        run.environmentId,
        run.environmentName,
        run.timeoutSeconds,
        run.tokenBudget,
        run.keyGeneration,
        run.memoryIn,
        run.createdAt,
      );
    return this.require(run.id);
  }

  get(id: string): Run | null {
    const row = this.db.sql.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      RunRow | undefined;
    return row ? toRun(row) : null;
  }

  require(id: string): Run {
    const run = this.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    return run;
  }

  /** The run a runner token belongs to, while the run is active. */
  byTokenHash(hash: string): Run | null {
    const row = this.db.sql
      .prepare(
        `SELECT * FROM runs WHERE run_token_hash = ? AND run_token_hash != '' AND status IN ('provisioning', 'running')`,
      )
      .get(hash) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  update(id: string, patch: RunPatch): Run {
    const entries = Object.entries(patch);
    if (entries.length > 0) {
      const sets = entries
        .map(([k]) => {
          const column = COLUMNS[k];
          if (!column) throw new Error(`Unknown run field ${k}`);
          return `${column} = ?`;
        })
        .join(', ');
      this.db.sql
        .prepare(`UPDATE runs SET ${sets} WHERE id = ?`)
        .run(...entries.map(([, v]) => v as string | number | null), id);
    }
    return this.require(id);
  }

  /** Moves a run to `to` only if it is still in one of `from` (no lost race with another path). */
  transition(id: string, from: readonly RunStatus[], to: RunStatus, patch: RunPatch = {}): boolean {
    const marks = from.map(() => '?').join(', ');
    const result = this.db.sql
      .prepare(`UPDATE runs SET status = ? WHERE id = ? AND status IN (${marks})`)
      .run(to, id, ...from);
    if (Number(result.changes) === 0) return false;
    this.update(id, patch);
    return true;
  }

  list(filter: RunFilter = {}): Run[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const add = (sql: string, value: string | undefined): void => {
      if (value === undefined) return;
      where.push(sql);
      args.push(value);
    };
    add('member_id = ?', filter.memberId);
    add('status = ?', filter.status);
    add('schedule_id = ?', filter.scheduleId);
    add('trigger_id = ?', filter.triggerId);
    add('workflow_id = ?', filter.workflowId);
    add('parent_run_id = ?', filter.parentRunId);
    add('harness = ?', filter.harness);
    add('created_at < ?', filter.before);
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, filter.limit ?? DEFAULT_LIST_LIMIT));
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM runs ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`;
    const rows = this.db.sql.prepare(sql).all(...args, limit) as unknown as RunRow[];
    return rows.map(toRun);
  }

  /** Runs in one of the given states, oldest first. */
  withStatus(statuses: readonly RunStatus[]): Run[] {
    const marks = statuses.map(() => '?').join(', ');
    const rows = this.db.sql
      .prepare(`SELECT * FROM runs WHERE status IN (${marks}) ORDER BY created_at, id`)
      .all(...statuses) as unknown as RunRow[];
    return rows.map(toRun);
  }

  countActive(memberId?: string): number {
    const sql = `SELECT COUNT(*) AS n FROM runs WHERE status IN ('provisioning', 'running')${
      memberId ? ' AND member_id = ?' : ''
    }`;
    const row = this.db.sql.prepare(sql).get(...(memberId ? [memberId] : [])) as { n: number };
    return row.n;
  }

  /** Runs a trigger launched that haven't finished yet (queued ones included). */
  countActiveForTrigger(triggerId: string): number {
    const row = this.db.sql
      .prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE trigger_id = ? AND status IN ('queued', 'provisioning', 'running')`,
      )
      .get(triggerId) as { n: number };
    return row.n;
  }

  // ---------------------------------------------------------------- workflows

  insertWorkflow(wf: NewWorkflow): Workflow {
    this.db.sql
      .prepare(
        `INSERT INTO workflows (id, member_id, member_name, prompt, template_id, template_name,
           account_ids, planner_template_id, planner_template_name, planner_harness,
           planner_provider, planner_model, executor_model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        wf.id,
        wf.memberId,
        wf.memberName,
        redact(wf.prompt),
        wf.templateId,
        wf.templateName,
        JSON.stringify(wf.accountIds),
        wf.plannerTemplateId,
        wf.plannerTemplateName,
        wf.plannerHarness,
        wf.plannerProvider,
        wf.plannerModel,
        wf.executorModel ?? '',
        wf.createdAt,
      );
    return this.requireWorkflow(wf.id);
  }

  workflow(id: string): Workflow | null {
    const row = this.db.sql.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as
      WorkflowRow | undefined;
    return row ? toWorkflow(row) : null;
  }

  requireWorkflow(id: string): Workflow {
    const wf = this.workflow(id);
    if (!wf) throw new Error(`Workflow ${id} not found`);
    return wf;
  }

  /** Workflows, newest first; a member's only when `memberId` is set. */
  workflows(memberId?: string, limit = DEFAULT_LIST_LIMIT): Workflow[] {
    const where = memberId ? 'WHERE member_id = ?' : '';
    const rows = this.db.sql
      .prepare(`SELECT * FROM workflows ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...(memberId ? [memberId] : []), limit) as unknown as WorkflowRow[];
    return rows.map(toWorkflow);
  }

  failWorkflow(id: string, failure: string): void {
    this.db.sql.prepare('UPDATE workflows SET failure = ? WHERE id = ?').run(failure, id);
  }

  /** The step runs of a workflow, in launch order. */
  workflowRuns(workflowId: string): Run[] {
    const rows = this.db.sql
      .prepare('SELECT * FROM runs WHERE workflow_id = ? ORDER BY created_at, id')
      .all(workflowId) as unknown as RunRow[];
    return rows.map(toRun);
  }

  // ---------------------------------------------------------------- events

  /** Stores a batch of runner events; already stored sequence numbers are ignored. */
  appendEvents(runId: string, events: readonly RunEvent[]): number {
    const insert = this.db.sql.prepare(
      `INSERT OR IGNORE INTO run_events (run_id, seq, at, type, text, tool, call_id, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.db.transaction(() => {
      let added = 0;
      for (const e of events) {
        const data = e.data === undefined ? null : JSON.stringify(redactDeep(e.data));
        const result = insert.run(
          runId,
          e.seq,
          e.at,
          e.type,
          clip(redact(e.text), RUNNER_LIMITS.eventText),
          e.tool ?? null,
          e.callId ?? null,
          data === null ? null : clip(data, RUNNER_LIMITS.eventData),
        );
        added += Number(result.changes);
      }
      return added;
    });
  }

  events(runId: string, afterSeq = -1, limit = MAX_EVENTS_PAGE): StoredEvent[] {
    const rows = this.db.sql
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, afterSeq, Math.min(limit, MAX_EVENTS_PAGE)) as unknown as EventRow[];
    return rows.map((r) => {
      const event: StoredEvent = { seq: r.seq, at: r.at, type: r.type, text: r.text, data: null };
      if (r.tool !== null) event.tool = r.tool;
      if (r.call_id !== null) event.callId = r.call_id;
      if (r.data !== null) event.data = parseData(r.data);
      return event;
    });
  }

  // ---------------------------------------------------------------- outputs

  /** Stores one chunk of an output file being uploaded; `commitOutput` makes the file visible. */
  putOutputChunk(runId: string, uploadId: string, seq: number, data: Uint8Array): void {
    this.db.sql
      .prepare('INSERT INTO run_output_chunks (run_id, upload_id, seq, data) VALUES (?, ?, ?, ?)')
      .run(runId, uploadId, seq, data);
  }

  /** Makes an uploaded file the run's output at `path`, replacing any previous one. */
  commitOutput(
    runId: string,
    path: string,
    upload: { id: string; size: number },
    createdAt: string,
    expiresAt: string,
  ): void {
    this.db.transaction(() => {
      const previous = this.db.sql
        .prepare('SELECT size, upload_id FROM run_outputs WHERE run_id = ? AND path = ?')
        .get(runId, path) as { size: number; upload_id: string | null } | undefined;
      if (previous?.upload_id) this.discardUpload(previous.upload_id);
      this.db.sql
        .prepare(
          `INSERT OR REPLACE INTO run_outputs
             (run_id, path, size, content, upload_id, created_at, expires_at)
           VALUES (?, ?, ?, X'', ?, ?, ?)`,
        )
        .run(runId, path, upload.size, upload.id, createdAt, expiresAt);
      this.db.sql
        .prepare('UPDATE runs SET outputs_bytes = outputs_bytes + ? WHERE id = ?')
        .run(upload.size - (previous?.size ?? 0), runId);
    });
  }

  /** Drops the chunks of an upload (an aborted one, or the file a new upload replaced). */
  discardUpload(uploadId: string): void {
    this.db.sql.prepare('DELETE FROM run_output_chunks WHERE upload_id = ?').run(uploadId);
  }

  outputs(runId: string): OutputFile[] {
    const rows = this.db.sql
      .prepare(
        'SELECT path, size, created_at, expires_at FROM run_outputs WHERE run_id = ? ORDER BY path',
      )
      .all(runId) as unknown as {
      path: string;
      size: number;
      created_at: string;
      expires_at: string;
    }[];
    return rows.map((r) => ({
      path: r.path,
      size: r.size,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  }

  outputCount(runId: string): number {
    const row = this.db.sql
      .prepare('SELECT COUNT(*) AS n FROM run_outputs WHERE run_id = ?')
      .get(runId) as { n: number };
    return row.n;
  }

  /** An output file's size and its content, chunk by chunk (read lazily), or null. */
  outputStream(runId: string, path: string): { size: number; chunks: Iterable<Buffer> } | null {
    const row = this.db.sql
      .prepare('SELECT size, upload_id FROM run_outputs WHERE run_id = ? AND path = ?')
      .get(runId, path) as { size: number; upload_id: string | null } | undefined;
    if (!row) return null;
    const { upload_id: uploadId } = row;
    return {
      size: row.size,
      chunks: uploadId === null ? this.legacyContent(runId, path) : this.chunks(uploadId),
    };
  }

  /** A whole output file, for small ones (use `outputStream` for anything that may be large). */
  output(runId: string, path: string): Buffer | null {
    const stream = this.outputStream(runId, path);
    return stream ? Buffer.concat([...stream.chunks]) : null;
  }

  private *chunks(uploadId: string): Generator<Buffer> {
    const next = this.db.sql.prepare(
      'SELECT data FROM run_output_chunks WHERE upload_id = ? AND seq = ?',
    );
    for (let seq = 0; ; seq++) {
      const row = next.get(uploadId, seq) as { data: Uint8Array } | undefined;
      if (!row) return;
      yield Buffer.from(row.data);
    }
  }

  /** Files stored before chunking keep their content in `run_outputs`. */
  private *legacyContent(runId: string, path: string): Generator<Buffer> {
    const row = this.db.sql
      .prepare('SELECT content FROM run_outputs WHERE run_id = ? AND path = ?')
      .get(runId, path) as { content: Uint8Array } | undefined;
    if (row) yield Buffer.from(row.content);
  }

  /**
   * Deletes expired output files, and chunks of uploads that never completed (the gateway stopped
   * mid-upload) once their run has long finished.
   */
  purgeExpiredOutputs(now: string): number {
    const abandonedBefore = new Date(Date.parse(now) - ABANDONED_UPLOAD_MS).toISOString();
    return this.db.transaction(() => {
      this.db.sql
        .prepare(
          `DELETE FROM run_output_chunks WHERE upload_id IN
             (SELECT upload_id FROM run_outputs WHERE expires_at <= ? AND upload_id IS NOT NULL)`,
        )
        .run(now);
      this.db.sql
        .prepare(
          `DELETE FROM run_output_chunks
           WHERE run_id IN (SELECT id FROM runs WHERE finished_at <= ?)
             AND upload_id NOT IN (SELECT upload_id FROM run_outputs WHERE upload_id IS NOT NULL)`,
        )
        .run(abandonedBefore);
      return Number(
        this.db.sql.prepare('DELETE FROM run_outputs WHERE expires_at <= ?').run(now).changes,
      );
    });
  }

  // ---------------------------------------------------------------- settings

  settings(): LaunchSettings {
    const row = this.db.sql.prepare('SELECT settings FROM launch_settings WHERE id = 1').get() as
      { settings: string } | undefined;
    return {
      ...DEFAULT_SETTINGS,
      ...(row ? (JSON.parse(row.settings) as Partial<LaunchSettings>) : {}),
    };
  }

  saveSettings(settings: LaunchSettings): void {
    this.db.sql
      .prepare('INSERT OR REPLACE INTO launch_settings (id, settings) VALUES (1, ?)')
      .run(JSON.stringify(settings));
  }

  memberLaunch(memberId: string): MemberLaunch {
    const row = this.db.sql
      .prepare('SELECT launch_enabled, max_concurrent FROM member_launch WHERE member_id = ?')
      .get(memberId) as { launch_enabled: number; max_concurrent: number | null } | undefined;
    return {
      memberId,
      launchEnabled: row ? row.launch_enabled === 1 : true,
      maxConcurrent: row?.max_concurrent ?? null,
    };
  }

  saveMemberLaunch(value: MemberLaunch): void {
    this.db.sql
      .prepare(
        'INSERT OR REPLACE INTO member_launch (member_id, launch_enabled, max_concurrent) VALUES (?, ?, ?)',
      )
      .run(value.memberId, value.launchEnabled ? 1 : 0, value.maxConcurrent);
  }
}

function parseData(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
