import { z } from 'zod';
import type { Database } from '../db/database.js';
import { redact } from '../db/redact.js';
import { badRequest, notFound } from '../errors.js';
import type { Gateway } from '../gateway.js';
import { randomId } from '../store/crypto.js';
import type { Member } from '../store/types.js';
import { type Actor, launchSchema, type Launchpad } from './launchpad.js';
import { type Harness, type LlmProvider, RUNNER_LIMITS } from './protocol.js';
import {
  isTimeZone,
  nextRun,
  nextRuns,
  PRESETS,
  type Preset,
  type Recurrence,
} from './recurrence.js';
import { clip, isActive, type Run } from './runStore.js';

const MAX_NAME_LENGTH = 100;
const LAST_MINUTE = 59;
const LAST_HOUR = 23;
const LAST_WEEKDAY = 6;
const LAST_DAY = 28;
const PREVIEW_RUNS = 3;
const SCHEDULE_NOT_FOUND = 'Schedule not found';

export const scheduleSchema = launchSchema.extend({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
  preset: z.enum(PRESETS),
  minute: z.number().int().min(0).max(LAST_MINUTE).default(0),
  hour: z.number().int().min(0).max(LAST_HOUR).default(0),
  weekday: z.number().int().min(0).max(LAST_WEEKDAY).default(1),
  dayOfMonth: z.number().int().min(1).max(LAST_DAY).default(1),
  timezone: z.string().refine(isTimeZone, 'Unknown time zone').default('UTC'),
});

export interface Schedule extends Recurrence {
  id: string;
  memberId: string;
  memberName: string;
  name: string;
  prompt: string;
  harness: Harness;
  provider: LlmProvider | null;
  model: string | null;
  templateId: string;
  accountIds: string[];
  keyGeneration: number;
  enabled: boolean;
  stoppedReason: string | null;
  memory: string | null;
  nextRunAt: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRow {
  id: string;
  member_id: string;
  member_name: string;
  name: string;
  prompt: string;
  harness: Harness;
  provider: LlmProvider | null;
  model: string | null;
  template_id: string;
  account_ids: string;
  preset: Preset;
  minute: number;
  hour: number;
  weekday: number;
  day_of_month: number;
  timezone: string;
  key_generation: number;
  enabled: number;
  stopped_reason: string | null;
  memory: string | null;
  next_run_at: string | null;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

function toSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    memberId: r.member_id,
    memberName: r.member_name,
    name: r.name,
    prompt: r.prompt,
    harness: r.harness,
    provider: r.provider,
    model: r.model,
    templateId: r.template_id,
    accountIds: JSON.parse(r.account_ids) as string[],
    preset: r.preset,
    minute: r.minute,
    hour: r.hour,
    weekday: r.weekday,
    dayOfMonth: r.day_of_month,
    timezone: r.timezone,
    keyGeneration: r.key_generation,
    enabled: r.enabled === 1,
    stoppedReason: r.stopped_reason,
    memory: r.memory,
    nextRunAt: r.next_run_at,
    lastRunId: r.last_run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Recurring agents: launches each due schedule's agent with the memory its last successful run
 * left, and stops a schedule for good when its member's key was rotated or revoked, the member is
 * gone, or the launch is no longer allowed.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly gateway: Gateway,
    private readonly launchpad: Launchpad,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- CRUD

  create(member: Member, input: unknown): Schedule {
    const req = scheduleSchema.parse(input);
    const plan = this.launchpad.plan(member, req);
    const keyGeneration = this.gateway.memberKeyGeneration(member.id);
    if (keyGeneration === null) throw badRequest('Your membership is no longer valid');
    const ts = this.now().toISOString();
    const id = randomId();
    const recurrence: Recurrence = {
      preset: req.preset,
      minute: req.minute,
      hour: req.hour,
      weekday: req.weekday,
      dayOfMonth: req.dayOfMonth,
      timezone: req.timezone,
    };
    this.db.sql
      .prepare(
        `INSERT INTO schedules (id, member_id, member_name, name, prompt, harness, provider, model, template_id,
           account_ids, preset, minute, hour, weekday, day_of_month, timezone, key_generation, enabled, next_run_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        member.id,
        member.name,
        req.name ?? clip(plan.prompt.split('\n')[0] ?? 'Scheduled agent', MAX_NAME_LENGTH),
        redact(plan.prompt),
        plan.harness,
        plan.provider,
        plan.model,
        plan.template.id,
        JSON.stringify(plan.accountIds),
        recurrence.preset,
        recurrence.minute,
        recurrence.hour,
        recurrence.weekday,
        recurrence.dayOfMonth,
        recurrence.timezone,
        keyGeneration,
        new Date(nextRun(recurrence, this.now().getTime())).toISOString(),
        ts,
        ts,
      );
    this.gateway.activity.add({
      kind: 'launchpad',
      detail: `Member "${member.name}" scheduled a ${plan.harness} agent (${recurrence.preset})`,
    });
    return this.require(id);
  }

  list(memberId?: string): Schedule[] {
    const rows = (memberId
      ? this.db.sql
          .prepare('SELECT * FROM schedules WHERE member_id = ? ORDER BY created_at DESC')
          .all(memberId)
      : this.db.sql
          .prepare('SELECT * FROM schedules ORDER BY created_at DESC')
          .all()) as unknown as ScheduleRow[];
    return rows.map(toSchedule);
  }

  get(id: string): Schedule | null {
    const row = this.db.sql.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as
      ScheduleRow | undefined;
    return row ? toSchedule(row) : null;
  }

  private require(id: string): Schedule {
    const schedule = this.get(id);
    if (!schedule) throw notFound(SCHEDULE_NOT_FOUND);
    return schedule;
  }

  /** A schedule the actor may see: members only their own. */
  visible(actor: Actor, id: string): Schedule {
    const schedule = this.get(id);
    if (!schedule || (actor.kind === 'member' && schedule.memberId !== actor.member.id)) {
      throw notFound(SCHEDULE_NOT_FOUND);
    }
    return schedule;
  }

  /** Next runs, for the UI. */
  preview(schedule: Schedule): string[] {
    if (!schedule.enabled) return [];
    return nextRuns(schedule, this.now().getTime(), PREVIEW_RUNS).map((t) =>
      new Date(t).toISOString(),
    );
  }

  /**
   * Pauses or resumes a schedule. Resuming (by its member) re-checks the launch and records the
   * member's current key generation; the admin can only pause.
   */
  setEnabled(actor: Actor, id: string, enabled: boolean): Schedule {
    const schedule = this.visible(actor, id);
    const ts = this.now().toISOString();
    if (!enabled) {
      const reason = actor.kind === 'admin' ? 'Paused by the admin' : 'Paused';
      this.update(id, { enabled: 0, stopped_reason: reason, next_run_at: null, updated_at: ts });
      return this.require(id);
    }
    if (actor.kind !== 'member') throw badRequest('Only its member can resume a schedule');
    this.launchpad.plan(actor.member, this.launchInput(schedule));
    const keyGeneration = this.gateway.memberKeyGeneration(actor.member.id);
    if (keyGeneration === null) throw badRequest('Your membership is no longer valid');
    this.update(id, {
      enabled: 1,
      stopped_reason: null,
      key_generation: keyGeneration,
      next_run_at: new Date(nextRun(schedule, this.now().getTime())).toISOString(),
      updated_at: ts,
    });
    return this.require(id);
  }

  delete(actor: Actor, id: string): void {
    this.visible(actor, id);
    this.db.sql.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  private update(id: string, fields: Record<string, string | number | null>): void {
    const sets = Object.keys(fields)
      .map((k) => `${k} = ?`)
      .join(', ');
    this.db.sql
      .prepare(`UPDATE schedules SET ${sets} WHERE id = ?`)
      .run(...Object.values(fields), id);
  }

  private launchInput(s: Schedule): Record<string, unknown> {
    return {
      prompt: s.prompt,
      templateId: s.templateId,
      accountIds: s.accountIds,
      harness: s.harness,
      ...(s.provider ? { provider: s.provider } : {}),
      ...(s.model ? { model: s.model } : {}),
    };
  }

  // ---------------------------------------------------------------- running

  /** Keeps the memory a successful scheduled run left (`MEMORY.md`). */
  onRunFinished(run: Run): void {
    if (!run.scheduleId || run.status !== 'succeeded' || run.memoryOut === null) return;
    this.update(run.scheduleId, {
      memory: clip(run.memoryOut, RUNNER_LIMITS.memory),
      updated_at: this.now().toISOString(),
    });
  }

  /** Launches every due schedule (serialized). */
  tick(): Promise<void> {
    this.ticking = this.ticking
      .then(() => {
        this.tickOnce();
      })
      .catch((err: unknown) => {
        console.error('Scheduler: tick failed', err);
      });
    return this.ticking;
  }

  private tickOnce(): void {
    const now = this.now();
    const rows = this.db.sql
      .prepare(
        'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at',
      )
      .all(now.toISOString()) as unknown as ScheduleRow[];
    for (const schedule of rows.map(toSchedule)) this.runDue(schedule, now);
  }

  private stop(schedule: Schedule, reason: string): void {
    this.update(schedule.id, {
      enabled: 0,
      stopped_reason: reason,
      next_run_at: null,
      updated_at: this.now().toISOString(),
    });
    this.gateway.activity.add({
      kind: 'launchpad',
      detail: `Stopped schedule "${schedule.name}" of "${schedule.memberName}": ${reason}`,
    });
  }

  private runDue(schedule: Schedule, now: Date): void {
    const member = this.gateway.activeMember(schedule.memberId);
    if (!member) {
      this.stop(schedule, 'The member no longer exists or has expired');
      return;
    }
    if (member.keyGeneration !== schedule.keyGeneration) {
      this.stop(schedule, 'The member key was rotated or revoked');
      return;
    }
    const next = new Date(nextRun(schedule, now.getTime())).toISOString();
    const last = schedule.lastRunId ? this.launchpad.runs.get(schedule.lastRunId) : null;
    if (last && isActive(last.status)) {
      this.update(schedule.id, { next_run_at: next });
      this.gateway.activity.add({
        kind: 'launchpad',
        detail: `Skipped schedule "${schedule.name}": its previous run is still going`,
      });
      return;
    }
    try {
      const run = this.launchpad.launch(member, this.launchInput(schedule), {
        scheduleId: schedule.id,
        memoryIn: schedule.memory,
        keyGeneration: schedule.keyGeneration,
      });
      this.update(schedule.id, { next_run_at: next, last_run_id: run.id });
    } catch (err) {
      this.stop(schedule, `Can't launch anymore: ${(err as Error).message}`);
    }
  }

  startTimer(intervalMs: number): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
