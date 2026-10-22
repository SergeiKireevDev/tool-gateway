import { z } from 'zod';
import type { Database } from '../db/database.js';
import { badRequest, notFound } from '../errors.js';
import { randomId } from '../store/crypto.js';
import { MAX_QUERY_LENGTH, parseQuery, QueryError } from './payloadQuery.js';

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const CHANNEL_NOT_FOUND = 'Conversation channel not found';

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
});

/**
 * A conversation channel: what makes a webhook trigger a duplex, long-lived conversation. The
 * admin defines it (its deliveries reach whoever can post to the webhook's source, and its agents
 * live on); members pick one of the enabled channels for their triggers. Its `conversationKey`, a
 * jq-like expression on the payload, keys the conversations.
 */
export interface ConversationChannel {
  id: string;
  name: string;
  description: string;
  conversationKey: string;
  /** Members can only pick enabled channels, and triggers on a disabled one stop. */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What members see of a channel they can pick. */
export type ChannelChoice = Pick<
  ConversationChannel,
  'id' | 'name' | 'description' | 'conversationKey'
>;

interface ChannelRow {
  id: string;
  name: string;
  description: string;
  conversation_key: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const toChannel = (r: ChannelRow): ConversationChannel => ({
  id: r.id,
  name: r.name,
  description: r.description,
  conversationKey: r.conversation_key,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The conversation channels the admin defined (`/api/admin/launchpad/channels`). */
export class Channels {
  constructor(
    private readonly db: Database,
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

  /** The channels members can pick now: the enabled ones. */
  choices(): ChannelChoice[] {
    return this.list()
      .filter((c) => c.enabled)
      .map(({ id, name, description, conversationKey }) => ({
        id,
        name,
        description,
        conversationKey,
      }));
  }

  /** The channel a trigger may use, or why not. */
  usable(id: string): ConversationChannel {
    const channel = this.get(id);
    if (!channel?.enabled) throw badRequest('This conversation channel is not available');
    return channel;
  }

  create(input: unknown): ConversationChannel {
    const req = channelSchema.parse(input);
    const ts = this.now().toISOString();
    const id = randomId();
    this.db.sql
      .prepare(
        `INSERT INTO conversation_channels (id, name, description, conversation_key, enabled,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, req.name, req.description, req.conversationKey, ts, ts);
    return this.require(id);
  }

  /** Edits a channel: its conversations stay under the keys they had. */
  update(id: string, input: unknown): ConversationChannel {
    this.require(id);
    const req = channelSchema.parse(input);
    this.db.sql
      .prepare(
        `UPDATE conversation_channels SET name = ?, description = ?, conversation_key = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(req.name, req.description, req.conversationKey, this.now().toISOString(), id);
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
