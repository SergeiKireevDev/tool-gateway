import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ActivityLog } from '../src/server/activity.js';
import { Database, IN_MEMORY } from '../src/server/db/database.js';
import { MIGRATIONS } from '../src/server/db/migrations.js';
import { redact, redactDeep } from '../src/server/db/redact.js';
import { createApp, createVmApp } from '../src/server/http/app.js';
import { createHarness } from './helpers.js';

describe('database', () => {
  it('migrates once and records the schema version', () => {
    const db = Database.open(IN_MEMORY);
    const row = db.sql.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBeGreaterThan(0);
  });

  it('turns the conversation keys members set into disabled channels', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'gw-db-')), 'gateway.db');
    const old = new DatabaseSync(file);
    const before = MIGRATIONS.length - 1;
    for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
    old.exec(`PRAGMA user_version = ${before}`);
    const insert = old.prepare(
      `INSERT INTO triggers (id, member_id, member_name, name, webhook_id, event_types,
         instructions, harness, template_id, account_ids, key_generation, enabled, created_at,
         updated_at, conversation_key)
       VALUES (?, 'm', 'Alice', 'T', 'w', '[]', 'Do it', 'claude-code', 't', '[]', 1, 1, ?, ?, ?)`,
    );
    const ts = '2026-10-22T00:00:00.000Z';
    insert.run('a', ts, ts, '.data.issueId');
    insert.run('b', ts, ts, '.data.issueId');
    insert.run('c', ts, ts, null);
    old.close();

    const db = Database.open(file);
    const channels = db.sql
      .prepare('SELECT id, conversation_key, enabled FROM conversation_channels')
      .all() as { id: string; conversation_key: string; enabled: number }[];
    expect(channels).toEqual([
      { id: expect.any(String), conversation_key: '.data.issueId', enabled: 0 },
    ]);
    const triggers = db.sql.prepare('SELECT id, channel_id FROM triggers ORDER BY id').all();
    expect(triggers).toEqual([
      { id: 'a', channel_id: channels[0]?.id },
      { id: 'b', channel_id: channels[0]?.id },
      { id: 'c', channel_id: null },
    ]);
    db.close();
  });

  it('rolls back failed transactions', () => {
    const db = Database.open(IN_MEMORY);
    const log = new ActivityLog(db);
    expect(() =>
      db.transaction(() => {
        log.add({ kind: 'admin', detail: 'inside' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(log.recent()).toEqual([]);
  });
});

describe('activity log', () => {
  it('persists entries, newest first, and lists them per session', () => {
    const db = Database.open(IN_MEMORY);
    const log = new ActivityLog(db);
    log.add({ kind: 'proxy', sessionId: 's1', sessionLabel: '', tool: 'github', detail: 'one' });
    log.add({ kind: 'proxy', sessionId: 's2', tool: 'slack', detail: 'two' });
    log.add({ kind: 'proxy', sessionId: 's1', tool: 'github', detail: 'three' });
    expect(log.recent().map((e) => e.detail)).toEqual(['three', 'two', 'one']);
    expect(log.forSessions(['s1']).map((e) => e.detail)).toEqual(['one', 'three']);
    expect(log.recent()[2]).not.toHaveProperty('sessionLabel');
    expect(log.forSessions([])).toEqual([]);
  });

  it('never stores keys or credentials', () => {
    const db = Database.open(IN_MEMORY);
    const log = new ActivityLog(db);
    log.add({
      kind: 'admin',
      path: '/x?t=gws_abcdef123',
      detail: 'used ghp_secret123 and sk-ant-api03-zzz',
    });
    const dump = JSON.stringify(db.sql.prepare('SELECT * FROM activity').all());
    expect(dump).not.toContain('abcdef123');
    expect(dump).not.toContain('secret123');
    expect(dump).not.toContain('api03');
  });
});

describe('redaction', () => {
  it('keeps prefixes and removes secrets, deeply', () => {
    expect(redact('Bearer gws_AbC-123 xoxb-1-2-3')).toBe('Bearer gws_[redacted] xoxb-[redacted]');
    expect(redactDeep({ a: ['sk-proj-0123456789abcdefXYZ'], n: 1 })).toEqual({
      a: ['sk-proj-[redacted]'],
      n: 1,
    });
  });
});

describe('VM-facing app', () => {
  it('serves only the proxy and session introspection', async () => {
    const h = await createHarness();
    const vm = createVmApp(h.gateway, h.config, { fetch: h.fetch });
    await request(vm).get('/api/session').expect(401);
    await request(vm).get('/proxy/github/user').expect(401);
    await request(vm).get('/api/admin/status').expect(404);
    await request(vm).get('/api/me').expect(404);
    await request(vm).get('/api/member').expect(404);
    await request(vm).get('/auth/google/login').expect(404);
    await request(vm).get('/').expect(404);
    // the regular app still has them
    await request(createApp(h.gateway, h.config)).get('/api/admin/status').expect(401);
  });
});
