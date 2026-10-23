import { z } from 'zod';
import type { Database } from '../db/database.js';
import { redact } from '../db/redact.js';
import { badRequest, notFound } from '../errors.js';
import type { Gateway } from '../gateway.js';
import { randomId } from '../store/crypto.js';
import type { Member, Session, WebhookSource } from '../store/types.js';
import { MS_PER_SECOND } from '../units.js';
import type { AcceptedDelivery, Webhooks } from '../webhooks.js';
import { type Actor, launchSchema, type Launchpad, MAX_PROMPT_LENGTH } from './launchpad.js';
import type { Harness } from './protocol.js';
import { clip, isActive, type Run } from './runStore.js';
import {
  type Conversation,
  type ConversationMessage,
  conversationKeyOf,
  Conversations,
} from './conversations.js';
import { Channels, type ConversationChannel } from './channels.js';
import { parseQuery } from './payloadQuery.js';
import type { PromptConversation } from './systemPrompt.js';
import {
  eventTypesSchema,
  hasFilters,
  MAX_EVENT_TYPE_LENGTH,
  matchesEventTypes,
  matchesFilters,
  parseFilters,
  type TriggerFilters,
  triggerFiltersSchema,
} from './triggerFilters.js';

const MAX_NAME_LENGTH = 100;
/** Runs a trigger may have queued or running at once; deliveries beyond that are skipped. */
export const MAX_ACTIVE_RUNS_PER_TRIGGER = 3;
/** Room for the event's header line in the run's prompt; the payload gets the rest. */
const HEADER_CHARS = 1000;
const PAYLOAD_CHARS = MAX_PROMPT_LENGTH - HEADER_CHARS;
const JSON_INDENT = 2;
const TRIGGER_NOT_FOUND = 'Trigger not found';
const CONVERSATION_NOT_FOUND = 'Conversation not found';
/** What a revived run is told of its conversation's past messages, in characters. */
const HISTORY_CHARS = 20_000;
/** Longest wait for a message, per request: the agent's tool asks again for longer waits. */
export const MAX_RECEIVE_WAIT_SECONDS = 50;
const MESSAGE_SEPARATOR = '\n\n---\n\n';

const MAX_ID_LENGTH = 100;
const CHANNEL_GONE = 'Its conversation channel was disabled or deleted';

export const triggerSchema = launchSchema.omit({ prompt: true }).extend({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
  webhookId: z.string().min(1),
  /**
   * Event types that launch the agent (`issues` also matches `issues.opened`); empty = all. None on
   * a conversation channel: its own pick the deliveries.
   */
  eventTypes: eventTypesSchema,
  /**
   * Deterministic conditions on the payload, checked before launching (see `triggerFilters`). None
   * on a conversation channel, like event types.
   */
  filters: triggerFiltersSchema,
  /**
   * Makes the trigger a conversation trigger: one of the conversation channels the admin enabled,
   * whose key expression keys long-lived conversations, served by one agent at a time, and whose
   * event types and filters pick the deliveries. Empty: none.
   */
  channelId: z
    .string()
    .max(MAX_ID_LENGTH)
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  /** Members no longer write key expressions: refused rather than silently ignored. */
  conversationKey: z
    .never({ error: 'Conversation keys are set by the admin: pick a conversation channel' })
    .optional(),
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
  filters: TriggerFilters;
  /** The conversation channel keying its conversations, or null: one run per delivery. */
  channelId: string | null;
  instructions: string;
  harness: Harness;
  model: string | null;
  templateId: string;
  accountIds: string[];
  /** The guest environment its runs boot (null: the default guest image). */
  environmentId: string | null;
  /** Skills of the member's library its runs start with (names). */
  skills: string[];
  keyGeneration: number;
  enabled: boolean;
  stoppedReason: string | null;
  lastRunId: string | null;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A trigger as the API returns it: with its webhook's name (null once deleted), and its
 * conversation channel's name, key expression, event types and agent TTL (null without one, or once
 * deleted).
 */
export type TriggerView = Trigger & {
  webhookName: string | null;
  channelName: string | null;
  conversationKey: string | null;
  channelEventTypes: string[] | null;
  channelAgentTtlSeconds: number | null;
};

interface TriggerRow {
  id: string;
  member_id: string;
  member_name: string;
  name: string;
  webhook_id: string;
  event_types: string;
  filters: string;
  channel_id: string | null;
  instructions: string;
  harness: Harness;
  model: string | null;
  template_id: string;
  account_ids: string;
  environment_id: string | null;
  skills: string;
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
    filters: parseFilters(r.filters),
    channelId: r.channel_id,
    instructions: r.instructions,
    harness: r.harness,
    model: r.model,
    templateId: r.template_id,
    accountIds: JSON.parse(r.account_ids) as string[],
    environmentId: r.environment_id,
    skills: JSON.parse(r.skills) as string[],
    keyGeneration: r.key_generation,
    enabled: r.enabled === 1,
    stoppedReason: r.stopped_reason,
    lastRunId: r.last_run_id,
    lastFiredAt: r.last_fired_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A trigger's name when none is given: the first line of its instructions. */
const defaultName = (instructions: string): string =>
  clip(instructions.split('\n')[0] ?? 'Webhook agent', MAX_NAME_LENGTH);

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
 * Webhook triggers: each accepted delivery on a member's webhook (or one the admin shares)
 * launches the agents its triggers describe, with the trigger's instructions in the system prompt
 * and the event's payload as the task. Like schedules, a trigger stops for good when its member's key is rotated or revoked, the
 * member is gone, or the launch is no longer allowed.
 */
export class Triggers {
  /** The conversations of conversation triggers. */
  readonly conversations: Conversations;
  /** The conversation channels the admin defined, which triggers pick. */
  readonly channels: Channels;

  constructor(
    private readonly db: Database,
    private readonly gateway: Gateway,
    private readonly launchpad: Launchpad,
    private readonly webhooks: Webhooks,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.conversations = new Conversations(db, now);
    this.channels = new Channels(db, () => gateway.listTemplates(), now);
    launchpad.onFinished((run) => {
      this.onRunFinished(run);
    });
    launchpad.useConversations((run) => this.promptConversation(run));
  }

  // ---------------------------------------------------------------- CRUD

  create(member: Member, input: unknown): Trigger {
    const req = triggerSchema.parse(input);
    const webhook = this.webhooks.usable(req.webhookId, member);
    if (!webhook) throw notFound('Webhook not found');
    const plan = this.launchpad.plan(member, { ...req, prompt: req.instructions });
    this.checkChannel(req, webhook.source, plan.template.id);
    const keyGeneration = this.gateway.memberKeyGeneration(member.id);
    if (keyGeneration === null) throw badRequest('Your membership is no longer valid');
    const ts = this.now().toISOString();
    const id = randomId();
    this.db.sql
      .prepare(
        `INSERT INTO triggers (id, member_id, member_name, name, webhook_id, event_types, filters,
           channel_id, instructions, harness, model, template_id, account_ids, environment_id,
           skills, key_generation, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        member.id,
        member.name,
        req.name ?? defaultName(req.instructions),
        req.webhookId,
        JSON.stringify(req.eventTypes),
        JSON.stringify(req.filters),
        req.channelId ?? null,
        redact(req.instructions),
        plan.harness,
        plan.model,
        plan.template.id,
        JSON.stringify(plan.accountIds),
        plan.environment?.id ?? null,
        JSON.stringify(plan.skills),
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

  /**
   * Replaces what a trigger does and listens to (by its member only): checked like a new trigger.
   * Its name stays unless a new one is given; whether it is paused does not change.
   */
  edit(member: Member, id: string, input: unknown): Trigger {
    const trigger = this.visible({ kind: 'member', member }, id);
    const req = triggerSchema.parse(input);
    const webhook = this.webhooks.usable(req.webhookId, member);
    if (!webhook) throw notFound('Webhook not found');
    const plan = this.launchpad.plan(member, { ...req, prompt: req.instructions });
    this.checkChannel(req, webhook.source, plan.template.id);
    this.update(id, {
      name: req.name ?? trigger.name,
      webhook_id: req.webhookId,
      event_types: JSON.stringify(req.eventTypes),
      filters: JSON.stringify(req.filters),
      channel_id: req.channelId ?? null,
      instructions: redact(req.instructions),
      harness: plan.harness,
      model: plan.model,
      template_id: plan.template.id,
      account_ids: JSON.stringify(plan.accountIds),
      environment_id: plan.environment?.id ?? null,
      skills: JSON.stringify(plan.skills),
      updated_at: this.now().toISOString(),
    });
    this.gateway.activity.add({
      kind: 'launchpad',
      detail: `Member "${member.name}" edited the agent trigger "${trigger.name}"`,
    });
    return this.require(id);
  }

  /**
   * The conversation channel a trigger may pick, if any: an enabled one that carries its webhook's
   * source, and whose agents' template (if it sets one) is the trigger's. The channel picks the
   * deliveries: the trigger sets no event types or filters of its own.
   */
  private checkChannel(
    { channelId, eventTypes, filters }: z.infer<typeof triggerSchema>,
    source: WebhookSource,
    templateId: string,
  ): void {
    if (channelId === undefined) return;
    const channel = this.channels.usable(channelId);
    if (eventTypes.length > 0 || hasFilters(filters)) {
      throw badRequest(
        'The conversation channel sets the event types and filters of its deliveries: leave them empty',
      );
    }
    if (channel.sources.length > 0 && !channel.sources.includes(source)) {
      throw badRequest(
        `This conversation channel only carries ${channel.sources.join(', ')} webhooks`,
      );
    }
    if (channel.templateId !== null && channel.templateId !== templateId) {
      const template = this.gateway.listTemplates().find((t) => t.id === channel.templateId);
      throw badRequest(
        `The agents of this conversation channel use template "${template?.name ?? channel.templateId}": pick it`,
      );
    }
  }

  list(memberId?: string): Trigger[] {
    const where = memberId ? 'WHERE member_id = ? ' : '';
    const rows = this.db.sql
      .prepare(`SELECT * FROM triggers ${where}ORDER BY created_at DESC`)
      .all(...(memberId ? [memberId] : [])) as unknown as TriggerRow[];
    return rows.map(toTrigger);
  }

  get(id: string): Trigger | null {
    const row = this.db.sql.prepare('SELECT * FROM triggers WHERE id = ?').get(id);
    return row ? toTrigger(row as unknown as TriggerRow) : null;
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
    const webhook = owner ? this.webhooks.usable(trigger.webhookId, owner) : null;
    const channel = trigger.channelId === null ? null : this.channels.get(trigger.channelId);
    return {
      ...trigger,
      webhookName: webhook?.name ?? null,
      channelName: channel?.name ?? null,
      conversationKey: channel?.conversationKey ?? null,
      channelEventTypes: channel?.eventTypes ?? null,
      channelAgentTtlSeconds: channel?.agentTtlSeconds ?? null,
    };
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
    if (!this.webhooks.usable(trigger.webhookId, actor.member)) {
      throw badRequest('Its webhook was deleted or is no longer shared');
    }
    const channel = trigger.channelId === null ? null : this.channels.get(trigger.channelId);
    if (trigger.channelId !== null && !channel?.enabled) throw badRequest(CHANNEL_GONE);
    this.launchpad.plan(actor.member, this.launchInput(trigger, trigger.instructions, channel));
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

  /**
   * What a run of the trigger launches. A conversation channel's agents get its template (with the
   * member's accounts for it picked anew when the admin changed it).
   */
  private launchInput(
    t: Trigger,
    prompt: string,
    channel: ConversationChannel | null = null,
  ): Record<string, unknown> {
    const templateId = channel?.templateId ?? t.templateId;
    return {
      prompt,
      templateId,
      accountIds: templateId === t.templateId ? t.accountIds : [],
      harness: t.harness,
      ...(t.model ? { model: t.model } : {}),
      ...(t.environmentId ? { environmentId: t.environmentId } : {}),
      ...(t.skills.length > 0 ? { skills: t.skills } : {}),
    };
  }

  // ---------------------------------------------------------------- firing

  /**
   * Launches the agents of the enabled triggers on the delivery's webhook that match its type and
   * whose filters its payload passes (a conversation channel's: see `fire`).
   */
  onDelivery(delivery: AcceptedDelivery): void {
    const rows = this.db.sql
      .prepare('SELECT * FROM triggers WHERE webhook_id = ? AND enabled = 1 ORDER BY created_at')
      .all(delivery.webhook.id) as unknown as TriggerRow[];
    for (const trigger of rows.map(toTrigger)) {
      if (
        trigger.channelId !== null ||
        (matchesEventTypes(trigger.eventTypes, delivery.eventType) &&
          matchesFilters(trigger.filters, delivery.payload))
      ) {
        this.fire(trigger, delivery);
      }
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

  /**
   * The trigger's member, when its runs may still launch; otherwise stops the trigger (member gone,
   * key rotated) and returns null.
   */
  private owner(trigger: Trigger): Member | null {
    const member = this.gateway.activeMember(trigger.memberId);
    if (!member) {
      this.stop(trigger, 'The member no longer exists or has expired');
      return null;
    }
    if (member.keyGeneration !== trigger.keyGeneration) {
      this.stop(trigger, 'The member key was rotated or revoked');
      return null;
    }
    return member;
  }

  private fire(trigger: Trigger, delivery: AcceptedDelivery): void {
    const member = this.owner(trigger);
    if (!member) return;
    // Only the member's own webhooks and those the admin shares launch their agents.
    const { ownerMemberId, shared } = delivery.webhook;
    if (ownerMemberId !== member.id && !(ownerMemberId === null && shared)) {
      this.stop(trigger, 'Its webhook is no longer shared');
      return;
    }
    if (trigger.channelId !== null) {
      const channel = this.channels.get(trigger.channelId);
      if (!channel?.enabled) this.stop(trigger, CHANNEL_GONE);
      // The channel carries only the deliveries the admin chose for it.
      else if (this.channels.carries(channel, delivery)) {
        this.converse(trigger, member, delivery, channel.conversationKey);
      }
      return;
    }
    if (this.launchpad.runs.countActiveForTrigger(trigger.id) >= MAX_ACTIVE_RUNS_PER_TRIGGER) {
      this.gateway.activity.add({
        kind: 'launchpad',
        detail: `Skipped trigger "${trigger.name}" for webhook event ${delivery.eventId}: ${MAX_ACTIVE_RUNS_PER_TRIGGER} of its runs are still going`,
      });
      return;
    }
    const now = this.now();
    this.launch(trigger, member, eventPrompt(delivery, now), {});
  }

  /** Launches one of the trigger's runs; a launch that is no longer allowed stops the trigger. */
  private launch(
    trigger: Trigger,
    member: Member,
    prompt: string,
    opts: { memoryIn?: string | null; channel?: ConversationChannel },
  ): Run | null {
    const now = this.now();
    const { channel = null, ...rest } = opts;
    const ttl = channel?.agentTtlSeconds ?? null;
    try {
      const run = this.launchpad.launch(member, this.launchInput(trigger, prompt, channel), {
        triggerId: trigger.id,
        instructions: trigger.instructions,
        keyGeneration: trigger.keyGeneration,
        ...(ttl === null ? {} : { timeoutSeconds: ttl }),
        ...rest,
      });
      this.update(trigger.id, { last_run_id: run.id, last_fired_at: now.toISOString() });
      return run;
    } catch (err) {
      this.stop(trigger, `Can't launch anymore: ${(err as Error).message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- conversations

  /**
   * A delivery of a conversation trigger: a message of the conversation its key names. Its agent
   * gets it if one is running; otherwise a run (re)starts the conversation.
   */
  private converse(
    trigger: Trigger,
    member: Member,
    delivery: AcceptedDelivery,
    expression: string,
  ): void {
    const key = conversationKeyOf(parseQuery(expression), delivery.payload);
    if (key === null) {
      this.gateway.activity.add({
        kind: 'launchpad',
        detail: `Skipped trigger "${trigger.name}" for webhook event ${delivery.eventId}: its payload gives no conversation key`,
      });
      return;
    }
    const conversation = this.conversations.open(trigger.id, member.id, key);
    this.conversations.add(conversation.id, {
      direction: 'in',
      text: eventPrompt(delivery, this.now()),
      eventId: delivery.eventId,
    });
    this.drain(trigger, member);
  }

  /**
   * Starts a run for each of the trigger's conversations that has messages waiting and no agent,
   * the longest waiting first, while the trigger has room for runs. The others wait for a run of
   * the trigger to end.
   */
  private drain(trigger: Trigger, member: Member): void {
    for (const conversation of this.conversations.waiting(trigger.id)) {
      if (this.serving(conversation)) continue;
      if (this.launchpad.runs.countActiveForTrigger(trigger.id) >= MAX_ACTIVE_RUNS_PER_TRIGGER) {
        this.gateway.activity.add({
          kind: 'launchpad',
          detail: `Conversation "${conversation.key}" of trigger "${trigger.name}" waits: ${MAX_ACTIVE_RUNS_PER_TRIGGER} of its runs are still going`,
        });
        return;
      }
      if (!this.revive(trigger, member, conversation)) return;
    }
  }

  /** Whether an agent is serving the conversation (queued or running). */
  private serving(conversation: Conversation): boolean {
    const run = conversation.runId === null ? null : this.launchpad.runs.get(conversation.runId);
    return run !== null && isActive(run.status);
  }

  /**
   * Starts a run of the conversation: its task is the messages waiting (as many as fit), it starts
   * from the memory the last run left, and its system prompt gives the history. It runs with the
   * channel's template and lives as long as the channel's agent TTL.
   */
  private revive(trigger: Trigger, member: Member, conversation: Conversation): boolean {
    const channel = trigger.channelId === null ? null : this.channels.get(trigger.channelId);
    if (!channel?.enabled) {
      this.stop(trigger, CHANNEL_GONE);
      return false;
    }
    const messages = fitting(this.conversations.pending(conversation.id));
    const run = this.launch(trigger, member, conversationPrompt(messages), {
      memoryIn: conversation.memory,
      channel,
    });
    if (!run) return false;
    this.conversations.give(run.id, messages);
    this.conversations.served(conversation.id, run.id);
    return true;
  }

  /**
   * After a conversation's run: keeps its memory and final message, then serves the messages
   * that arrived meanwhile and the other conversations waiting for room.
   */
  onRunFinished(run: Run): void {
    if (run.triggerId === null) return;
    const conversation = this.conversations.forRun(run.id);
    if (!conversation) return;
    if (run.memoryOut !== null) this.conversations.remember(conversation.id, run.memoryOut);
    if (run.finalMessage) {
      this.conversations.add(conversation.id, {
        direction: 'out',
        text: run.finalMessage,
        runId: run.id,
      });
    }
    const trigger = this.get(run.triggerId);
    if (!trigger?.enabled) return;
    const member = this.owner(trigger);
    if (member) this.drain(trigger, member);
  }

  /** What a conversation's run is told about it, for its system prompt. */
  private promptConversation(run: Run): PromptConversation | null {
    if (run.triggerId === null) return null;
    const conversation = this.conversations.forRun(run.id);
    if (!conversation) return null;
    return {
      key: conversation.key,
      earlierRuns: conversation.runs - 1,
      history: this.conversations
        .history(conversation.id, run.id, HISTORY_CHARS)
        .map(({ at, direction, text }) => ({ at, direction, text })),
    };
  }

  /** The trigger's conversations, for the actor (members: their own triggers). */
  listConversations(actor: Actor, triggerId: string): Conversation[] {
    this.visible(actor, triggerId);
    return this.conversations.list(triggerId);
  }

  private visibleConversation(actor: Actor, triggerId: string, id: string): Conversation {
    this.visible(actor, triggerId);
    const conversation = this.conversations.get(id);
    if (conversation?.triggerId !== triggerId) throw notFound(CONVERSATION_NOT_FOUND);
    return conversation;
  }

  conversationMessages(
    actor: Actor,
    triggerId: string,
    id: string,
    page: { after?: number; limit?: number },
  ): ConversationMessage[] {
    const conversation = this.visibleConversation(actor, triggerId, id);
    return this.conversations.messages(conversation.id, page.after, page.limit);
  }

  /** Forgets a conversation: the next delivery with its key starts a new one. */
  deleteConversation(actor: Actor, triggerId: string, id: string): void {
    this.visibleConversation(actor, triggerId, id);
    this.conversations.delete(id);
  }

  // ---------------------------------------------------------------- the agent's side

  /** The conversation the session key's run serves; 404 for runs outside a conversation. */
  sessionConversation(session: Session): { conversation: Conversation; run: Run } {
    const issuer = session.issuedBy;
    const run = issuer?.kind === 'launchpad' ? this.launchpad.runs.get(issuer.runId) : null;
    const conversation = run && isActive(run.status) ? this.conversations.forRun(run.id) : null;
    if (!run || !conversation) throw notFound('This run is not part of a conversation');
    return { conversation, run };
  }

  /** The messages that arrived for the session's run, waiting up to `waitSeconds` for one. */
  async receive(session: Session, waitSeconds: number): Promise<ConversationMessage[]> {
    const { conversation, run } = this.sessionConversation(session);
    const seconds = Math.min(Math.max(0, waitSeconds), MAX_RECEIVE_WAIT_SECONDS);
    return this.conversations.receive(conversation.id, run.id, seconds * MS_PER_SECOND);
  }

  /** Records what the session's agent says in its conversation. */
  reply(session: Session, text: string): ConversationMessage {
    const { conversation, run } = this.sessionConversation(session);
    return this.conversations.add(conversation.id, { direction: 'out', text, runId: run.id });
  }
}

/** The pending messages a run's task holds: the oldest, then as many as fit in a prompt. */
function fitting(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  let used = 0;
  for (const m of messages) {
    used += m.text.length + MESSAGE_SEPARATOR.length;
    if (used > PAYLOAD_CHARS && out.length > 0) break;
    out.push(m);
  }
  return out;
}

/** The task of a conversation's run: the messages it starts from. */
function conversationPrompt(messages: readonly ConversationMessage[]): string {
  const texts = messages.map((m) => m.text);
  const text =
    texts.length === 1
      ? (texts[0] ?? '')
      : [`${texts.length} webhook events arrived:`, ...texts].join(MESSAGE_SEPARATOR);
  return clip(text, PAYLOAD_CHARS);
}
