import { z } from 'zod';
import type { Database } from '../db/database.js';
import { badRequest, notFound } from '../errors.js';
import { randomId } from '../store/crypto.js';
import type { WebhookSource } from '../store/types.js';
import { SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from '../units.js';
import { WEBHOOK_SOURCES } from '../webhooks.js';
import { KEY_MARGIN_SECONDS } from './launchpad.js';
import { MAX_QUERY_LENGTH, parseQuery, QueryError } from './payloadQuery.js';
import {
  eventTypesSchema,
  matchesEventTypes,
  matchesFilters,
  parseFilters,
  type TriggerFilters,
  triggerFiltersSchema,
} from './triggerFilters.js';

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_ID_LENGTH = 100;
const CHANNEL_NOT_FOUND = 'Conversation channel not found';
const MIN_AGENT_TTL_MINUTES = 5;
/** Longest an agent of a channel may live: a day, for long-lived sessions. */
const MAX_AGENT_TTL_HOURS = 24;
export const MIN_AGENT_TTL_SECONDS = MIN_AGENT_TTL_MINUTES * SECONDS_PER_MINUTE;
export const MAX_AGENT_TTL_SECONDS = MAX_AGENT_TTL_HOURS * SECONDS_PER_HOUR;

/** A conversation key expression: it must parse (see `payloadQuery`). */
const conversationKeySchema = z
  .string()
  .trim()
  .min(1, 'Give the conversation key expression')
  .max(MAX_QUERY_LENGTH)
  .superRefine((v, ctx) => {
    try {
      parseQuery(v);
    } catch (err) {
      if (!(err instanceof QueryError)) throw err;
      ctx.addIssue({ code: 'custom', message: `Conversation key: ${err.message}` });
    }
  });

export const channelSchema = z.object({
  name: z.string().trim().min(1, 'Name the channel').max(MAX_NAME_LENGTH),
  description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).default(''),
  conversationKey: conversationKeySchema,
  /**
   * The types of notification the channel carries (`Comment` also matches `Comment.create`);
   * empty = all. Triggers on the channel set none of their own.
   */
  eventTypes: eventTypesSchema,
  /** The sources of the webhooks whose deliveries it carries (like a trigger's webhook); empty = any. */
  sources: z
    .array(z.enum(WEBHOOK_SOURCES))
    .default([])
    .transform((list) => [...new Set(list)]),
  /** Conditions on the payload, like a trigger's; triggers on the channel set none of their own. */
  filters: triggerFiltersSchema,
  /** The access template its agents get (triggers on the channel must use it); none: the trigger's. */
  templateId: z
    .string()
    .max(MAX_ID_LENGTH)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  /** How long each of its agents may live, in seconds; none: the launchpad's default timeout. */
  agentTtlSeconds: z
    .number()
    .int()
    .min(MIN_AGENT_TTL_SECONDS)
    .max(MAX_AGENT_TTL_SECONDS)
    .nullish()
    .transform((v) => v ?? null),
});

/** What channels need to know of the admin's templates: which exist, and how long keys may last. */
export interface ChannelTemplate {
  id: string;
  name: string;
  maxTtlSeconds: number;
}

/**
 * A conversation channel: what makes a webhook trigger a duplex, long-lived conversation. The
 * admin defines it (its deliveries reach whoever can post to the webhook's source, and its agents
 * live on); members pick one of the enabled channels for their triggers. Its `conversationKey`, a
 * jq-like expression on the payload, keys the conversations; its `eventTypes`, `sources` and
 * `filters` pick which deliveries reach them, like a trigger's. It also sets the access template
 * of its agents and how long they live (`agentTtlSeconds`), so that they can serve long sessions.
 */
export interface ConversationChannel {
  id: string;
  name: string;
  description: string;
  conversationKey: string;
  /** Event types its conversations hear (sub-types included); empty: every event. */
  eventTypes: string[];
  /** Sources of the webhooks it carries; empty: any. */
  sources: WebhookSource[];
  filters: TriggerFilters;
  /** The access template its agents get, or null: the trigger's own. */
  templateId: string | null;
  /** How long each of its agents may live (capped by the template's max TTL); null: default. */
  agentTtlSeconds: number | null;
  /** Members can only pick enabled channels, and triggers on a disabled one stop. */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What members see of a channel they can pick. */
export type ChannelChoice = Pick<
  ConversationChannel,
  | 'id'
  | 'name'
  | 'description'
  | 'conversationKey'
  | 'eventTypes'
  | 'sources'
  | 'filters'
  | 'templateId'
  | 'agentTtlSeconds'
>;

interface ChannelRow {
  id: string;
  name: string;
  description: string;
  conversation_key: string;
  event_types: string;
  sources: string;
  filters: string;
  template_id: string | null;
  agent_ttl_seconds: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const toChannel = (r: ChannelRow): ConversationChannel => ({
  id: r.id,
  name: r.name,
  description: r.description,
  conversationKey: r.conversation_key,
  eventTypes: JSON.parse(r.event_types) as string[],
  sources: JSON.parse(r.sources) as WebhookSource[],
  filters: parseFilters(r.filters),
  templateId: r.template_id,
  agentTtlSeconds: r.agent_ttl_seconds,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The conversation channels the admin defined (`/api/admin/launchpad/channels`). */
export class Channels {
  constructor(
    private readonly db: Database,
    /** The admin's templates, which a channel's agents may get. */
    private readonly templates: () => ChannelTemplate[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): ConversationChannel[] {
    const rows = this.db.sql
      .prepare('SELECT * FROM conversation_channels ORDER BY name, id')
      .all() as unknown as ChannelRow[];
    return rows.map(toChannel);
  }

  get(id: string): ConversationChannel | null {
    const row = this.db.sql.prepare('SELECT * FROM conversation_channels WHERE id = ?').get(id);
    return row ? toChannel(row as unknown as ChannelRow) : null;
  }

  require(id: string): ConversationChannel {
    const channel = this.get(id);
    if (!channel) throw notFound(CHANNEL_NOT_FOUND);
    return channel;
  }

  /**
   * The channels a member can pick now: the enabled ones whose template (if any) is one of the
   * member's.
   */
  choices(templateIds: ReadonlySet<string>): ChannelChoice[] {
    return this.list()
      .filter((c) => c.enabled && (c.templateId === null || templateIds.has(c.templateId)))
      .map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        conversationKey: c.conversationKey,
        eventTypes: c.eventTypes,
        sources: c.sources,
        filters: c.filters,
        templateId: c.templateId,
        agentTtlSeconds: c.agentTtlSeconds,
      }));
  }

  /** Whether a delivery is one the channel carries: its source, event type and filters. */
  carries(
    channel: ConversationChannel,
    delivery: { webhook: { source: WebhookSource }; eventType: string | null; payload: unknown },
  ): boolean {
    return (
      (channel.sources.length === 0 || channel.sources.includes(delivery.webhook.source)) &&
      matchesEventTypes(channel.eventTypes, delivery.eventType) &&
      matchesFilters(channel.filters, delivery.payload)
    );
  }

  /** The request, checked: its template exists and keys of it last long enough for its agents. */
  private parse(input: unknown): z.infer<typeof channelSchema> {
    const req = channelSchema.parse(input);
    if (req.templateId === null) return req;
    const template = this.templates().find((t) => t.id === req.templateId);
    if (!template) throw badRequest('Template not found');
    const longest = template.maxTtlSeconds - KEY_MARGIN_SECONDS;
    if (req.agentTtlSeconds !== null && req.agentTtlSeconds > longest) {
      throw badRequest(
        `Template "${template.name}" keys last too little for this agent TTL (at most ${longest}s)`,
      );
    }
    return req;
  }

  /** The channel a trigger may use, or why not. */
  usable(id: string): ConversationChannel {
    const channel = this.get(id);
    if (!channel?.enabled) throw badRequest('This conversation channel is not available');
    return channel;
  }

  create(input: unknown): ConversationChannel {
    const req = this.parse(input);
    const ts = this.now().toISOString();
    const id = randomId();
    this.db.sql
      .prepare(
        `INSERT INTO conversation_channels (id, name, description, conversation_key, event_types,
           sources, filters, template_id, agent_ttl_seconds, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        req.name,
        req.description,
        req.conversationKey,
        JSON.stringify(req.eventTypes),
        JSON.stringify(req.sources),
        JSON.stringify(req.filters),
        req.templateId,
        req.agentTtlSeconds,
        ts,
        ts,
      );
    return this.require(id);
  }

  /**
   * Edits a channel: its conversations stay under the keys they had, and its triggers' next runs
   * use its new template and agent TTL.
   */
  update(id: string, input: unknown): ConversationChannel {
    this.require(id);
    const req = this.parse(input);
    this.db.sql
      .prepare(
        `UPDATE conversation_channels SET name = ?, description = ?, conversation_key = ?,
           event_types = ?, sources = ?, filters = ?, template_id = ?, agent_ttl_seconds = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        req.name,
        req.description,
        req.conversationKey,
        JSON.stringify(req.eventTypes),
        JSON.stringify(req.sources),
        JSON.stringify(req.filters),
        req.templateId,
        req.agentTtlSeconds,
        this.now().toISOString(),
        id,
      );
    return this.require(id);
  }

  setEnabled(id: string, enabled: boolean): ConversationChannel {
    this.require(id);
    this.db.sql
      .prepare('UPDATE conversation_channels SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, this.now().toISOString(), id);
    return this.require(id);
  }

  /** Deletes a channel: the triggers on it stop at their next delivery. */
  delete(id: string): ConversationChannel {
    const channel = this.require(id);
    this.db.sql.prepare('DELETE FROM conversation_channels WHERE id = ?').run(id);
    return channel;
  }
}
