import { isRecord } from '../tools/json.js';
import type { WebhookSource } from '../store/types.js';

/**
 * Lanes for duplex (conversational) triggers, see `docs/duplex.md`: a lane is the unit of work a
 * delivery is about (a Linear issue, a GitHub issue or pull request, a monday.com item). Every
 * delivery of a lane reaches the same live agent; deliveries of other lanes never do. Lanes are
 * derived deterministically from the payload, never by a model.
 */

export interface Lane {
  /** Stable key of the unit of work, unique within a source (`github:octo/app#12`). */
  key: string;
  /** Human-readable name of the unit of work (`SER-12`, `octo/app#12`). */
  label: string;
}

const record = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** A non-empty string, or a number as a string; null otherwise. */
function text(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Linear: an issue, or the issue a comment is on. */
function linearLane(p: Record<string, unknown>): Lane | null {
  const data = record(p.data);
  const issue = p.type === 'Comment' ? record(data.issue) : data;
  const id = p.type === 'Comment' ? (text(data.issueId) ?? text(issue.id)) : text(data.id);
  if ((p.type !== 'Issue' && p.type !== 'Comment') || id === null) return null;
  return { key: `linear:issue:${id}`, label: text(issue.identifier) ?? id };
}

/**
 * GitHub: an issue or pull request (they share their repository's numbers, and comments on a pull
 * request arrive as issue comments), or a discussion.
 */
function githubLane(p: Record<string, unknown>): Lane | null {
  const repo = text(record(p.repository).full_name);
  if (repo === null) return null;
  const number = text(record(p.issue ?? p.pull_request).number);
  if (number !== null) return { key: `github:${repo}#${number}`, label: `${repo}#${number}` };
  const discussion = text(record(p.discussion).number);
  if (discussion === null) return null;
  return {
    key: `github:${repo}/discussions/${discussion}`,
    label: `${repo} discussion #${discussion}`,
  };
}

/** monday.com: an item (its updates, i.e. comments, carry the same `pulseId`). */
function mondayLane(p: Record<string, unknown>): Lane | null {
  const event = record(p.event);
  const board = text(event.boardId);
  const item = text(event.pulseId);
  if (board === null || item === null) return null;
  const name = text(event.pulseName);
  return { key: `monday:${board}:${item}`, label: name ?? `item ${item}` };
}

/** The lane a delivery belongs to, or null when it isn't about one unit of work. */
export function laneOf(source: WebhookSource, payload: unknown): Lane | null {
  if (!isRecord(payload)) return null;
  switch (source) {
    case 'linear':
      return linearLane(payload);
    case 'github':
      return githubLane(payload);
    case 'monday':
      return mondayLane(payload);
    case 'generic':
      return null;
  }
}

/** Identities (ids, logins, emails) of whoever caused the event, to recognize the agent's own. */
export function actorsOf(source: WebhookSource, payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const ids = (...vs: unknown[]): string[] => vs.map(text).filter((v): v is string => v !== null);
  switch (source) {
    case 'linear': {
      const actor = record(payload.actor);
      return ids(actor.id, actor.email, record(payload.data).userId);
    }
    case 'github': {
      const sender = record(payload.sender);
      return ids(sender.id, sender.login);
    }
    case 'monday':
      return ids(record(payload.event).userId);
    case 'generic':
      return [];
  }
}

/**
 * Whether the event was caused by the tool account the agent acts as (its `userId` or `login`
 * identity): such deliveries are the agent's own replies coming back, and must not wake it.
 */
export function causedBy(actors: readonly string[], identity: Record<string, string>): boolean {
  const own = new Set(
    [identity.userId, identity.login]
      .filter((v): v is string => typeof v === 'string' && v !== '')
      .map((v) => v.toLowerCase()),
  );
  return actors.some((a) => own.has(a.toLowerCase()));
}
