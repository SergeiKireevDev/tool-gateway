import { describe, expect, it } from 'vitest';
import { conversationKeyOf } from '../src/server/launchpad/conversations.js';
import { parseQuery, QueryError } from '../src/server/launchpad/payloadQuery.js';

const payload = {
  action: 'update',
  data: {
    id: 'c7f0',
    number: 42,
    title: 'Duplex agents',
    team: { key: 'SER' },
    labels: [{ name: 'bug' }, { name: 'ui' }],
    'odd key': true,
  },
  repository: { full_name: 'o/r' },
  issue: null,
};

const run = (expr: string, input: unknown = payload): unknown[] => parseQuery(expr).run(input);

describe('payload queries', () => {
  it('follows paths', () => {
    expect(run('.')).toEqual([payload]);
    expect(run('.data.id')).toEqual(['c7f0']);
    expect(run('.data."odd key"')).toEqual([true]);
    expect(run('.data["team"].key')).toEqual(['SER']);
    expect(run('.data.labels[0].name')).toEqual(['bug']);
    expect(run('.data.labels[-1].name')).toEqual(['ui']);
    expect(run('.data.labels[].name')).toEqual(['bug', 'ui']);
    expect(run('.missing.deeper')).toEqual([null]);
    expect(run('.issue.number')).toEqual([null]);
  });

  it('builds values and combines them', () => {
    expect(run('[.data.team.key, .data.number]')).toEqual([['SER', 42]]);
    expect(run('{team: .data.team.key, n: .data.number}')).toEqual([{ team: 'SER', n: 42 }]);
    expect(run('.data | {id, title}')).toEqual([{ id: 'c7f0', title: 'Duplex agents' }]);
    expect(run('.data.team.key + "-" + (.data.number | tostring)')).toEqual(['SER-42']);
    expect(run('.issue.id // .data.id')).toEqual(['c7f0']);
    expect(run('[.data.labels[].name] | join(",")')).toEqual(['bug,ui']);
    expect(run('.data.title | ascii_downcase | split(" ")')).toEqual([['duplex', 'agents']]);
    expect(run('.data.labels | map(.name) | length')).toEqual([2]);
    expect(run('.data.labels[] | select(.name == "ui") | .name')).toEqual(['ui']);
    expect(run('.data.number > 40 and .action != "create"')).toEqual([true]);
    expect(run('.data | has("id"), (keys | first)')).toEqual([true, 'id']);
    expect(run('"Issue-" | ltrimstr("Issue-"), rtrimstr("-")')).toEqual(['', 'Issue']);
    expect(run('-1, 2.5e1, null, false')).toEqual([-1, 25, null, false]);
  });

  it('fails on type errors, unless asked not to', () => {
    expect(() => run('.data.id.x')).toThrow(QueryError);
    expect(run('.data.id.x?')).toEqual([]);
    expect(run('.data.id[]? // "none"')).toEqual(['none']);
  });

  it('rejects malformed expressions', () => {
    for (const bad of ['', '.a |', '.a[', '{(.a)}', 'nope', 'select()', '"open', '.a $']) {
      expect(() => parseQuery(bad), bad).toThrow(QueryError);
    }
    expect(() => parseQuery('['.repeat(100))).toThrow(/nested too deeply/);
    expect(() => parseQuery(`.${'a'.repeat(600)}`)).toThrow(/longer than/);
  });

  it('bounds how many values an expression yields', () => {
    const wide = { xs: Array.from({ length: 100 }, (_, i) => i) };
    expect(run('[.xs[]] | length', wide)).toEqual([100]);
    expect(() => run('[.xs[] + .xs[]]', wide)).toThrow(/too many values/);
  });
});

describe('conversation keys', () => {
  const key = (expr: string, input: unknown = payload) =>
    conversationKeyOf(parseQuery(expr), input);

  it('is the text of the values the expression gives', () => {
    expect(key('.data.id')).toBe('c7f0');
    expect(key('.data.number')).toBe('42');
    expect(key('.repository.full_name, .data.number')).toBe('["o/r",42]');
    expect(key('{r: .repository.full_name}')).toBe('{"r":"o/r"}');
  });

  it('is null when the payload gives none, or a useless one', () => {
    expect(key('.issue.id')).toBeNull();
    expect(key('.data.id.x')).toBeNull();
    expect(key('empty')).toBeNull();
    expect(key('""')).toBeNull();
    expect(key('.', { text: 'x'.repeat(300) })).toBeNull();
    expect(key('.data.token', { data: { token: 'gws_secretvalue' } })).toBe('gws_[redacted]');
  });
});
