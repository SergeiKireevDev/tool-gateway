import type { Database } from '../db/database.js';
import { redact } from '../db/redact.js';
import { randomId } from '../store/crypto.js';
import { isRecord } from '../tools/json.js';
import { type Json, type PayloadQuery, QueryError } from './payloadQuery.js';
import { clip } from './runStore.js';

/**
 * Conversations: the long-lived, keyed exchanges of a conversation trigger. Every delivery whose
 * payload gives the same key (its channel's `conversationKey` expression) is a message of the same
 * conversation. Messages reach the conversation's running agent, which asks for them
 * (`receive`); when none is running, the next run revives the conversation with its history and
 * the `MEMORY.md` its last run left.
 */

/** Longest conversation key: longer ones (a whole payload…) are refused, not clipped. */
export const MAX_KEY_LENGTH = 200;
/** One message, in characters. */
export const MAX_MESSAGE_CHARS = 50_000;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

export type MessageDirection = 'in' | 'out';

export interface Conversation {
  id: string;
  triggerId: string;
  memberId: string;
  key: string;
  /** `MEMORY.md` its last run left, given to the next one. */
  memory: string | null;
  /** The run serving it now, or the last one. */
  runId: string | null;
  /** Runs it had so far. */
  runs: number;
  /** Messages that arrived and no run has been given yet. */
  pending: number;
  messages: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: number;
  at: string;
  /** `in`: a webhook event; `out`: what one of its agents said (a reply, or a final message). */
  direction: MessageDirection;
  /** The webhook event an `in` message is, if any. */
  eventId: number | null;
  /** `in`: the run it was given to (null while pending); `out`: the run that wrote it. */
  runId: string | null;
  text: string;
}

interface ConversationRow {
  id: string;
  trigger_id: string;
  member_id: string;
  key: string;
  memory: string | null;
  run_id: string | null;
  runs: number;
  pending: number;
  messages: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  at: string;
  direction: MessageDirection;
  event_id: number | null;
  run_id: string | null;
  text: string;
}

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  triggerId: r.trigger_id,
  memberId: r.member_id,
  key: r.key,
  memory: r.memory,
  runId: r.run_id,
  runs: r.runs,
  pending: r.pending,
  messages: r.messages,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMessage = (r: MessageRow): ConversationMessage => ({
  id: r.id,
  at: r.at,
  direction: r.direction,
  eventId: r.event_id,
  runId: r.run_id,
  text: r.text,
});

const SELECT_CONVERSATION = `SELECT c.*,
   (SELECT COUNT(*) FROM conversation_messages m
     WHERE m.conversation_id = c.id AND m.direction = 'in' AND m.run_id IS NULL) AS pending,
   (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS messages
 FROM conversations c`;

/**
 * The conversation key a payload gives: the expression's non-null values, as text (a single
 * string as is, anything else as JSON). Null when it gives none, fails, or is too long.
 */
export function conversationKeyOf(query: PayloadQuery, payload: unknown): string | null {
  let values: Json[];
  try {
    values = query.run(payload).filter((v) => v !== null);
  } catch (err) {
    if (err instanceof QueryError) return null;
    throw err;
  }
  if (values.length === 0) return null;
  const value = values.length === 1 ? values[0] : values;
  const key = typeof value === 'string' ? value : JSON.stringify(value);
  if (key === '' || key.length > MAX_KEY_LENGTH || (isRecord(value) && key === '{}')) return null;
  return redact(key);
}

export class Conversations {
  /** Agents waiting for a message, by conversation. */
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(id: string): Conversation | null {
    const row = this.db.sql.prepare(`${SELECT_CONVERSATION} WHERE c.id = ?`).get(id);
    return row ? toConversation(row as unknown as ConversationRow) : null;
  }

  /** The trigger's conversations, most recently active first. */
  list(triggerId: string): Conversation[] {
    const rows = this.db.sql
      .prepare(`${SELECT_CONVERSATION} WHERE c.trigger_id = ? ORDER BY c.updated_at DESC`)
      .all(triggerId) as unknown as ConversationRow[];
    return rows.map(toConversation);
  }

  /** The conversation a run serves (or served last), if any. */
  forRun(runId: string): Conversation | null {
    const row = this.db.sql.prepare(`${SELECT_CONVERSATION} WHERE c.run_id = ?`).get(runId);
    return row ? toConversation(row as unknown as ConversationRow) : null;
  }

  /** The trigger's conversation for this key, opened on its first message. */
  open(triggerId: string, memberId: string, key: string): Conversation {
    const ts = this.now().toISOString();
    this.db.sql
      .prepare(
        `INSERT INTO conversations (id, trigger_id, member_id, key, runs, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT (trigger_id, key) DO NOTHING`,
      )
      .run(randomId(), triggerId, memberId, key, ts, ts);
    const row = this.db.sql
      .prepare(`${SELECT_CONVERSATION} WHERE c.trigger_id = ? AND c.key = ?`)
      .get(triggerId, key) as unknown as ConversationRow;
    return toConversation(row);
  }

  delete(id: string): void {
    this.db.sql.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    this.wake(id);
  }

  /** Adds a message; an agent waiting for one wakes up. */
  add(
    conversationId: string,
    msg: { direction: MessageDirection; text: string; eventId?: number; runId?: string },
  ): ConversationMessage {
    const at = this.now().toISOString();
    const text = clip(redact(msg.text), MAX_MESSAGE_CHARS);
    const row = this.db.sql
      .prepare(
        `INSERT INTO conversation_messages (conversation_id, at, direction, event_id, run_id, text)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        conversationId,
        at,
        msg.direction,
        msg.eventId ?? null,
        msg.runId ?? null,
        text,
      ) as unknown as MessageRow;
    this.db.sql
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(at, conversationId);
    if (msg.direction === 'in') this.wake(conversationId);
    return toMessage(row);
  }

  /** Messages, oldest first, after a message id. */
  messages(conversationId: string, after = 0, limit = DEFAULT_PAGE): ConversationMessage[] {
    const rows = this.db.sql
      .prepare(
        'SELECT * FROM conversation_messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?',
      )
      .all(
        conversationId,
        after,
        Math.min(Math.max(1, limit), MAX_PAGE),
      ) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /** The messages no run was given yet, oldest first. */
  pending(conversationId: string): ConversationMessage[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM conversation_messages
         WHERE conversation_id = ? AND direction = 'in' AND run_id IS NULL ORDER BY id`,
      )
      .all(conversationId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /** The trigger's conversations with pending messages, the longest waiting first. */
  waiting(triggerId: string): Conversation[] {
    const rows = this.db.sql
      .prepare(
        `${SELECT_CONVERSATION} WHERE c.trigger_id = ? AND EXISTS (
           SELECT 1 FROM conversation_messages m
           WHERE m.conversation_id = c.id AND m.direction = 'in' AND m.run_id IS NULL)
         ORDER BY (SELECT MIN(m.id) FROM conversation_messages m
           WHERE m.conversation_id = c.id AND m.direction = 'in' AND m.run_id IS NULL)`,
      )
      .all(triggerId) as unknown as ConversationRow[];
    return rows.map(toConversation);
  }

  /** Gives pending messages to a run (they are its task, or it asked for them). */
  give(runId: string, messages: readonly ConversationMessage[]): void {
    const stmt = this.db.sql.prepare(
      'UPDATE conversation_messages SET run_id = ? WHERE id = ? AND run_id IS NULL',
    );
    for (const m of messages) stmt.run(runId, m.id);
  }

  /** A new run serves the conversation, starting from its last memory. */
  served(conversationId: string, runId: string): void {
    this.db.sql
      .prepare('UPDATE conversations SET run_id = ?, runs = runs + 1, updated_at = ? WHERE id = ?')
      .run(runId, this.now().toISOString(), conversationId);
  }

  /** Keeps the `MEMORY.md` a run left, for the next one. */
  remember(conversationId: string, memory: string): void {
    this.db.sql
      .prepare('UPDATE conversations SET memory = ? WHERE id = ?')
      .run(memory, conversationId);
  }

  /**
   * A run's history: the messages earlier runs got or wrote, most recent last, within a size
   * budget. Its own messages and those still pending are not.
   */
  history(conversationId: string, runId: string, budget: number): ConversationMessage[] {
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM conversation_messages
         WHERE conversation_id = ? AND run_id IS NOT NULL AND run_id != ? ORDER BY id DESC`,
      )
      .iterate(conversationId, runId) as Iterable<unknown>;
    const out: ConversationMessage[] = [];
    let used = 0;
    for (const row of rows) {
      const message = toMessage(row as MessageRow);
      used += message.text.length;
      if (used > budget && out.length > 0) break;
      out.unshift(message);
    }
    return out;
  }

  /**
   * Gives the run the conversation's pending messages; when there are none, waits up to `waitMs`
   * for one. Empty when none arrived (or the conversation is gone).
   */
  async receive(
    conversationId: string,
    runId: string,
    waitMs: number,
  ): Promise<ConversationMessage[]> {
    const first = this.claim(conversationId, runId);
    if (first.length > 0 || waitMs <= 0) return first;
    await this.waitFor(conversationId, waitMs);
    return this.get(conversationId) ? this.claim(conversationId, runId) : [];
  }

  private claim(conversationId: string, runId: string): ConversationMessage[] {
    const pending = this.pending(conversationId);
    this.give(runId, pending);
    return pending.map((m) => ({ ...m, runId }));
  }

  private waitFor(conversationId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.waiters.get(conversationId) ?? new Set<() => void>();
      this.waiters.set(conversationId, waiters);
      const done = (): void => {
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0) this.waiters.delete(conversationId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
    });
  }

  private wake(conversationId: string): void {
    for (const done of [...(this.waiters.get(conversationId) ?? [])]) done();
  }
}
