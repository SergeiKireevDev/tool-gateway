import { z } from 'zod';
import type { Database } from '../db/database.js';
import { redact } from '../db/redact.js';
import { badRequest, notFound } from '../errors.js';
import type { Gateway } from '../gateway.js';
import { randomId } from '../store/crypto.js';
import type { Member } from '../store/types.js';
import type { AcceptedDelivery, Webhooks } from '../webhooks.js';
import { type Actor, launchSchema, type Launchpad, MAX_PROMPT_LENGTH } from './launchpad.js';
import type { Harness } from './protocol.js';
import { clip } from './runStore.js';

const MAX_NAME_LENGTH = 100;
const MAX_EVENT_TYPES = 20;
const MAX_EVENT_TYPE_LENGTH = 100;
/** Runs a trigger may have queued or running at once; deliveries beyond that are skipped. */
export const MAX_ACTIVE_RUNS_PER_TRIGGER = 3;
/** Room for the event's header line in the run's prompt; the payload gets the rest. */
const HEADER_CHARS = 1000;
const PAYLOAD_CHARS = MAX_PROMPT_LENGTH - HEADER_CHARS;
const JSON_INDENT = 2;
const TRIGGER_NOT_FOUND = 'Trigger not found';

export const triggerSchema = launchSchema.omit({ prompt: true }).extend({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
  webhookId: z.string().min(1),
  /** Event types that launch the agent (`issues` also matches `issues.opened`); empty = all. */
  eventTypes: z
    .array(z.string().trim().min(1).max(MAX_EVENT_TYPE_LENGTH))
    .max(MAX_EVENT_TYPES)
    .default([]),
  /** What the agent should do with an event: added to its system prompt. */
  instructions: z
    .string()
    .trim()
    .min(1, 'Describe what the agent should do')
    .max(MAX_PROMPT_LENGTH),
});

export interface Trigger {
  id: string;
  memberId: string;
  memberName: string;
  name: string;
  webhookId: string;
  eventTypes: string[];
  instructions: string;
  harness: Harness;
  model: string | null;
  templateId: string;
  accountIds: string[];
  keyGeneration: number;
  enabled: boolean;
  stoppedReason: string | null;
  lastRunId: string | null;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A trigger as the API returns it: with its webhook's name (null once deleted). */
export type TriggerView = Trigger & { webhookName: string | null };

interface TriggerRow {
  id: string;
  member_id: string;
  member_name: string;
  name: string;
  webhook_id: string;
  event_types: string;
  instructions: string;
  harness: Harness;
  model: string | null;
  template_id: string;
  account_ids: string;
  key_generation: number;
  enabled: number;
  stopped_reason: string | null;
  last_run_id: string | null;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

function toTrigger(r: TriggerRow): Trigger {
  return {
    id: r.id,
    memberId: r.member_id,
    memberName: r.member_name,
    name: r.name,
    webhookId: r.webhook_id,
    eventTypes: JSON.parse(r.event_types) as string[],
    instructions: r.instructions,
    harness: r.harness,
    model: r.model,
    templateId: r.template_id,
    accountIds: JSON.parse(r.account_ids) as string[],
    keyGeneration: r.key_generation,
    enabled: r.enabled === 1,
    stoppedReason: r.stopped_reason,
    lastRunId: r.last_run_id,
    lastFiredAt: r.last_fired_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Whether an event type is one a trigger listens to: equal, or a sub-type (`issues.opened`). */
export function matchesEventTypes(patterns: readonly string[], eventType: string | null): boolean {
  if (patterns.length === 0) return true;
  if (eventType === null) return false;
  return patterns.some((p) => eventType === p || eventType.startsWith(`${p}.`));
}

/** The run's prompt: which event arrived, and its payload (redacted, size-capped). */
export function eventPrompt(delivery: AcceptedDelivery, at: Date): string {
  const type = delivery.eventType ? ` \`${clip(delivery.eventType, MAX_EVENT_TYPE_LENGTH)}\`` : '';
  const json = JSON.stringify(delivery.payload, null, JSON_INDENT);
  return [
    `Webhook event${type} received by "${delivery.webhook.name}" (${delivery.webhook.source}) at ${at.toISOString()}.`,
    '',
    'Payload:',
    '```json',
    clip(json, PAYLOAD_CHARS),
    '```',
  ].join('\n');
}

/**
 * Webhook triggers: each accepted delivery on a member's webhook launches the agents its triggers
 * describe, with the trigger's instructions in the system prompt and the event's payload as the
 * task. Like schedules, a trigger stops for good when its member's key is rotated or revoked, the
 * member is gone, or the launch is no longer allowed.
 */
export class Triggers {
  constructor(
    private readonly db: Database,
    private readonly gateway: Gateway,
    private readonly launchpad: Launchpad,
    private readonly webhooks: Webhooks,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------------------------------------------------------------- CRUD

  create(member: Member, input: unknown): Trigger {
    const req = triggerSchema.parse(input);
    if (!this.webhooks.visible(req.webhookId, { kind: 'member', member })) {
      throw notFound('Webhook not found');
    }
    const plan = this.launchpad.plan(member, { ...req, prompt: req.instructions });
    const keyGeneration = this.gateway.memberKeyGeneration(member.id);
    if (keyGeneration === null) throw badRequest('Your membership is no longer valid');
    const ts = this.now().toISOString();
    const id = randomId();
    this.db.sql
      .prepare(
        `INSERT INTO triggers (id, member_id, member_name, name, webhook_id, event_types, instructions, harness,
           model, template_id, account_ids, key_generation, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        member.id,
        member.name,
        req.name ?? clip(req.instructions.split('\n')[0] ?? 'Webhook agent', MAX_NAME_LENGTH),
        req.webhookId,
        JSON.stringify([...new Set(req.eventTypes)]),
        redact(req.instructions),
        plan.harness,
        plan.model,
        plan.template.id,
        JSON.stringify(plan.accountIds),
        keyGeneration,
        ts,
        ts,
      );
    this.gateway.activity.add({
      kind: 'launchpad',
      detail: `Member "${member.name}" added a ${plan.harness} agent trigger on a webhook`,
    });
    return this.require(id);
  }

  list(memberId?: string): Trigger[] {
    const rows = (memberId
      ? this.db.sql
          .prepare('SELECT * FROM triggers WHERE member_id = ? ORDER BY created_at DESC')
          .all(memberId)
      : this.db.sql
          .prepare('SELECT * FROM triggers ORDER BY created_at DESC')
          .all()) as unknown as TriggerRow[];
    return rows.map(toTrigger);
  }

  get(id: string): Trigger | null {
    const row = this.db.sql.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as
      TriggerRow | undefined;
    return row ? toTrigger(row) : null;
  }

  private require(id: string): Trigger {
    const trigger = this.get(id);
    if (!trigger) throw notFound(TRIGGER_NOT_FOUND);
    return trigger;
  }

  /** A trigger the actor may see: members only their own. */
  visible(actor: Actor, id: string): Trigger {
    const trigger = this.get(id);
    if (!trigger || (actor.kind === 'member' && trigger.memberId !== actor.member.id)) {
      throw notFound(TRIGGER_NOT_FOUND);
    }
    return trigger;
  }

  view(trigger: Trigger): TriggerView {
    const owner = this.gateway.activeMember(trigger.memberId);
    const webhook = owner
      ? this.webhooks.visible(trigger.webhookId, { kind: 'member', member: owner })
      : null;
    return { ...trigger, webhookName: webhook?.name ?? null };
  }

  /**
   * Pauses or resumes a trigger. Resuming (by its member) re-checks the launch and records the
   * member's current key generation; the admin can only pause.
   */
  setEnabled(actor: Actor, id: string, enabled: boolean): Trigger {
    const trigger = this.visible(actor, id);
    const ts = this.now().toISOString();
    if (!enabled) {
      const reason = actor.kind === 'admin' ? 'Paused by the admin' : 'Paused';
      this.update(id, { enabled: 0, stopped_reason: reason, updated_at: ts });
      return this.require(id);
    }
    if (actor.kind !== 'member') throw badRequest('Only its member can resume a trigger');
    if (!this.webhooks.visible(trigger.webhookId, actor)) {
      throw badRequest('Its webhook was deleted');
    }
    this.launchpad.plan(actor.member, this.launchInput(trigger, trigger.instructions));
    const keyGeneration = this.gateway.memberKeyGeneration(actor.member.id);
    if (keyGeneration === null) throw badRequest('Your membership is no longer valid');
    this.update(id, {
      enabled: 1,
      stopped_reason: null,
      key_generation: keyGeneration,
      updated_at: ts,
    });
    return this.require(id);
  }

  delete(actor: Actor, id: string): void {
    this.visible(actor, id);
    this.db.sql.prepare('DELETE FROM triggers WHERE id = ?').run(id);
  }

  private update(id: string, fields: Record<string, string | number | null>): void {
    const sets = Object.keys(fields)
      .map((k) => `${k} = ?`)
      .join(', ');
    this.db.sql
      .prepare(`UPDATE triggers SET ${sets} WHERE id = ?`)
      .run(...Object.values(fields), id);
  }

  private launchInput(t: Trigger, prompt: string): Record<string, unknown> {
    return {
      prompt,
      templateId: t.templateId,
      accountIds: t.accountIds,
      harness: t.harness,
      ...(t.model ? { model: t.model } : {}),
    };
  }

  // ---------------------------------------------------------------- firing

  /** Launches the agents of the enabled triggers on the delivery's webhook that match its type. */
  onDelivery(delivery: AcceptedDelivery): void {
    const rows = this.db.sql
      .prepare('SELECT * FROM triggers WHERE webhook_id = ? AND enabled = 1 ORDER BY created_at')
      .all(delivery.webhook.id) as unknown as TriggerRow[];
    for (const trigger of rows.map(toTrigger)) {
      if (matchesEventTypes(trigger.eventTypes, delivery.eventType)) this.fire(trigger, delivery);
    }
  }

  private stop(trigger: Trigger, reason: string): void {
    this.update(trigger.id, {
      enabled: 0,
      stopped_reason: reason,
      updated_at: this.now().toISOString(),
    });
    this.gateway.activity.add({
      kind: 'launchpad',
      detail: `Stopped trigger "${trigger.name}" of "${trigger.memberName}": ${reason}`,
    });
  }

  private fire(trigger: Trigger, delivery: AcceptedDelivery): void {
    const member = this.gateway.activeMember(trigger.memberId);
    if (!member) {
      this.stop(trigger, 'The member no longer exists or has expired');
      return;
    }
    if (member.keyGeneration !== trigger.keyGeneration) {
      this.stop(trigger, 'The member key was rotated or revoked');
      return;
    }
    // Only the member's own webhooks launch their agents.
    if (delivery.webhook.ownerMemberId !== member.id) return;
    if (this.launchpad.runs.countActiveForTrigger(trigger.id) >= MAX_ACTIVE_RUNS_PER_TRIGGER) {
      this.gateway.activity.add({
        kind: 'launchpad',
        detail: `Skipped trigger "${trigger.name}" for webhook event ${delivery.eventId}: ${MAX_ACTIVE_RUNS_PER_TRIGGER} of its runs are still going`,
      });
      return;
    }
    const now = this.now();
    try {
      const run = this.launchpad.launch(
        member,
        this.launchInput(trigger, eventPrompt(delivery, now)),
        {
          triggerId: trigger.id,
          instructions: trigger.instructions,
          keyGeneration: trigger.keyGeneration,
        },
      );
      this.update(trigger.id, { last_run_id: run.id, last_fired_at: now.toISOString() });
    } catch (err) {
      this.stop(trigger, `Can't launch anymore: ${(err as Error).message}`);
    }
  }
}
