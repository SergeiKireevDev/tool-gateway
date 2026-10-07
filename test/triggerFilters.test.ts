import { describe, expect, it } from 'vitest';
import {
  assigneesSetBy,
  matchesFilters,
  NO_FILTERS,
  parseFilters,
  statusesSetBy,
  triggerFiltersSchema,
} from '../src/server/launchpad/triggerFilters.js';

const linearUpdate = (updatedFrom: object, data: object = {}) => ({
  type: 'Issue',
  action: 'update',
  updatedFrom,
  data: {
    title: 'Crash on start',
    state: { name: 'Todo' },
    assigneeId: 'u-1',
    assignee: { id: 'u-1', name: 'Ada Lovelace', email: 'ada@example.com' },
    ...data,
  },
});

const filters = (f: object) => triggerFiltersSchema.parse(f);

describe('status changes', () => {
  it('reads Linear state changes, not other updates', () => {
    expect(statusesSetBy(linearUpdate({ stateId: 's-0' }))).toEqual(['Todo']);
    expect(statusesSetBy(linearUpdate({ description: 'old' }))).toEqual([]);
  });

  it('reads GitHub closes, merges, reopens and project status fields', () => {
    expect(statusesSetBy({ action: 'closed', issue: { number: 1 } })).toEqual(['closed']);
    const merged = { action: 'closed', pull_request: { merged: true } };
    expect(statusesSetBy(merged)).toEqual(['closed', 'merged']);
    expect(statusesSetBy({ action: 'reopened', issue: {} })).toEqual(['open', 'reopened']);
    const projectItem = {
      action: 'edited',
      projects_v2_item: {},
      changes: { field_value: { to: { name: 'In review' } } },
    };
    expect(statusesSetBy(projectItem)).toEqual(['In review']);
    expect(statusesSetBy({ action: 'opened', issue: {} })).toEqual([]);
  });

  it('reads monday.com status columns', () => {
    const event = (columnType: string) => ({
      event: { type: 'update_column_value', columnType, value: { label: { text: 'Done' } } },
    });
    expect(statusesSetBy(event('color'))).toEqual(['Done']);
    expect(statusesSetBy(event('text'))).toEqual([]);
  });
});

describe('assignments', () => {
  it('reads Linear assignee changes and issues created assigned', () => {
    const assigned = assigneesSetBy(linearUpdate({ assigneeId: null }));
    expect(assigned).toEqual(['u-1', 'Ada Lovelace', 'ada@example.com', 'u-1']);
    expect(assigneesSetBy(linearUpdate({ stateId: 's-0' }))).toEqual([]);
    const created = { type: 'Issue', action: 'create', data: { assignee: { name: 'Bob' } } };
    expect(assigneesSetBy(created)).toEqual(['Bob']);
  });

  it('reads the GitHub assigned action', () => {
    const payload = { action: 'assigned', issue: {}, assignee: { login: 'octocat', id: 42 } };
    expect(assigneesSetBy(payload)).toEqual(['42', 'octocat']);
    expect(assigneesSetBy({ ...payload, action: 'unassigned' })).toEqual([]);
  });

  it('reads people added to a monday.com people column', () => {
    const payload = {
      event: {
        columnType: 'multiple-person',
        value: { personsAndTeams: [{ id: 1 }, { id: 2 }] },
        previousValue: { personsAndTeams: [{ id: 1 }] },
      },
    };
    expect(assigneesSetBy(payload)).toEqual(['2']);
  });
});

describe('matching', () => {
  const payload = linearUpdate({ stateId: 's-0' });

  it('passes everything without filters', () => {
    expect(matchesFilters(NO_FILTERS, null)).toBe(true);
    expect(matchesFilters(filters({}), payload)).toBe(true);
  });

  it('matches keywords in values, case-insensitively, not in keys', () => {
    expect(matchesFilters(filters({ contains: ['nope', 'CRASH'] }), payload)).toBe(true);
    expect(matchesFilters(filters({ contains: ['assignee'] }), payload)).toBe(false);
    expect(matchesFilters(filters({ contains: ['crash'] }), null)).toBe(false);
  });

  it('matches statuses and assignees exactly, case-insensitively', () => {
    expect(matchesFilters(filters({ statusChangedTo: ['todo'] }), payload)).toBe(true);
    expect(matchesFilters(filters({ statusChangedTo: ['To'] }), payload)).toBe(false);
    const assigned = linearUpdate({ assigneeId: null });
    expect(matchesFilters(filters({ assignedTo: ['ADA@example.com'] }), assigned)).toBe(true);
    expect(matchesFilters(filters({ assignedTo: ['ada'] }), assigned)).toBe(false);
  });

  it('requires every filter that is set', () => {
    const both = linearUpdate({ stateId: 's-0', assigneeId: null });
    const f = filters({ contains: ['crash'], statusChangedTo: ['Todo'], assignedTo: ['u-1'] });
    expect(matchesFilters(f, both)).toBe(true);
    expect(matchesFilters(f, payload)).toBe(false);
  });
});

describe('stored filters', () => {
  it('fill in missing lists and drop duplicates', () => {
    expect(parseFilters('{}')).toEqual(NO_FILTERS);
    expect(parseFilters('{"contains":["a","a"]}')).toEqual({ ...NO_FILTERS, contains: ['a'] });
    expect(parseFilters('{"contains":"a"}')).toEqual(NO_FILTERS);
  });
});
