import { z } from 'zod';
import { isRecord } from '../tools/json.js';

/**
 * Deterministic trigger filters: checked on each delivery before an agent is launched, so that a
 * trigger only spends a run on the events it is about. Each filter is a list of values (any of
 * them matches, case-insensitively); every filter that is set must match.
 *
 * - `contains`: one of the keywords appears in one of the payload's text values.
 * - `statusChangedTo`: the event moves an item to one of these statuses (Linear issue state,
 *   GitHub issue / pull request closed, merged or reopened, GitHub project status field, monday.com
 *   status column).
 * - `assignedTo`: the event assigns an item to one of these people, by name, email, login or id
 *   (Linear assignee, GitHub `assigned` action, monday.com people column).
 */

const MAX_VALUES = 20;
const MAX_VALUE_LENGTH = 200;

const values = z
  .array(z.string().trim().min(1).max(MAX_VALUE_LENGTH))
  .max(MAX_VALUES)
  .default([])
  .transform((list) => [...new Set(list)]);

export interface TriggerFilters {
  contains: string[];
  statusChangedTo: string[];
  assignedTo: string[];
}

export const NO_FILTERS: TriggerFilters = { contains: [], statusChangedTo: [], assignedTo: [] };

export const triggerFiltersSchema = z
  .object({ contains: values, statusChangedTo: values, assignedTo: values })
  .default(NO_FILTERS);

/** Filters as stored: anything missing or malformed counts as "no filter". */
export function parseFilters(json: string): TriggerFilters {
  const parsed = triggerFiltersSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : NO_FILTERS;
}

const norm = (s: string): string => s.trim().toLowerCase();

const record = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

/** The non-empty strings (and numbers, as strings) among the values. */
function strings(...vs: unknown[]): string[] {
  const out: string[] = [];
  for (const v of vs) {
    if (typeof v === 'number') out.push(String(v));
    if (typeof v === 'string' && v !== '') out.push(v);
  }
  return out;
}

/** Every string (and number) value in the payload, keys excluded. Iterative: payloads nest. */
export function textValues(payload: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'number') out.push(String(v));
    else if (Array.isArray(v)) stack.push(...(v as unknown[]));
    else if (isRecord(v)) stack.push(...Object.values(v));
  }
  return out;
}

// ---------------------------------------------------------------- status changes

/** Linear: an update whose `updatedFrom` holds the previous `stateId`. */
function linearStatus(p: Record<string, unknown>): string[] {
  if (!isRecord(p.updatedFrom) || !('stateId' in p.updatedFrom)) return [];
  return strings(record(record(p.data).state).name);
}

/** GitHub: issues and pull requests closed (or merged) and reopened; project status fields. */
function githubStatus(p: Record<string, unknown>): string[] {
  const item = p.pull_request ?? p.issue;
  const out: string[] = [];
  if (isRecord(item) && p.action === 'closed') {
    out.push('closed');
    if (item.merged === true) out.push('merged');
  }
  if (isRecord(item) && p.action === 'reopened') out.push('open', 'reopened');
  const fieldValue = record(record(p.changes).field_value);
  return [...out, ...strings(record(fieldValue.to).name)];
}

const MONDAY_STATUS_COLUMNS = new Set(['color', 'status']);
const MONDAY_PEOPLE_COLUMNS = new Set(['multiple-person', 'people']);
const columnType = (event: Record<string, unknown>): string =>
  typeof event.columnType === 'string' ? event.columnType : '';

/** monday.com: a status column's new label. */
function mondayStatus(p: Record<string, unknown>): string[] {
  const event = record(p.event);
  if (!MONDAY_STATUS_COLUMNS.has(columnType(event))) return [];
  return strings(record(record(event.value).label).text);
}

/** The statuses the event moves an item to. */
export function statusesSetBy(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  return [...linearStatus(payload), ...githubStatus(payload), ...mondayStatus(payload)];
}

// ---------------------------------------------------------------- assignments

const identities = (person: unknown): string[] => {
  const p = record(person);
  return strings(p.id, p.name, p.displayName, p.email, p.login);
};

/** Linear: an issue created with, or updated to, an assignee. */
function linearAssignees(p: Record<string, unknown>): string[] {
  const changed =
    (isRecord(p.updatedFrom) && 'assigneeId' in p.updatedFrom) ||
    (p.action === 'create' && isRecord(p.data));
  if (!changed) return [];
  const data = record(p.data);
  return [...identities(data.assignee), ...strings(data.assigneeId)];
}

/** GitHub: the `assigned` action names who was assigned. */
function githubAssignees(p: Record<string, unknown>): string[] {
  return p.action === 'assigned' ? identities(p.assignee) : [];
}

const mondayPeople = (value: unknown): string[] => {
  const list = record(value).personsAndTeams;
  return Array.isArray(list) ? list.flatMap((x) => strings(record(x).id)) : [];
};

/** monday.com: people added to a people column (by user id). */
function mondayAssignees(p: Record<string, unknown>): string[] {
  const event = record(p.event);
  if (!MONDAY_PEOPLE_COLUMNS.has(columnType(event))) return [];
  const before = new Set(mondayPeople(event.previousValue));
  return mondayPeople(event.value).filter((id) => !before.has(id));
}

/** Who the event assigns an item to: ids, names, emails or logins. */
export function assigneesSetBy(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  return [...linearAssignees(payload), ...githubAssignees(payload), ...mondayAssignees(payload)];
}

// ---------------------------------------------------------------- matching

const anyEqual = (wanted: readonly string[], found: readonly string[]): boolean => {
  const set = new Set(found.map(norm));
  return wanted.some((w) => set.has(norm(w)));
};

const anyContained = (keywords: readonly string[], texts: readonly string[]): boolean => {
  const haystack = texts.map(norm);
  return keywords.some((k) => haystack.some((t) => t.includes(norm(k))));
};

/** Whether a delivery's payload passes every filter that is set. */
export function matchesFilters(filters: TriggerFilters, payload: unknown): boolean {
  const { contains, statusChangedTo, assignedTo } = filters;
  return (
    (contains.length === 0 || anyContained(contains, textValues(payload))) &&
    (statusChangedTo.length === 0 || anyEqual(statusChangedTo, statusesSetBy(payload))) &&
    (assignedTo.length === 0 || anyEqual(assignedTo, assigneesSetBy(payload)))
  );
}
