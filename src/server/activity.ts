import type { Database } from './db/database.js';
import { redact } from './db/redact.js';

export interface ActivityEntry {
  at: string;
  kind: 'proxy' | 'admin' | 'member' | 'launchpad';
  sessionId?: string;
  sessionLabel?: string;
  tool?: string;
  method?: string;
  path?: string;
  status?: number;
  decision?: 'allowed' | 'denied';
  detail: string;
}

interface ActivityRow {
  at: string;
  kind: ActivityEntry['kind'];
  session_id: string | null;
  session_label: string | null;
  tool: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  decision: ActivityEntry['decision'] | null;
  detail: string;
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;

/** Activity log persisted in the database, shown in the UI and queryable per session. */
export class ActivityLog {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  add({ sessionLabel, ...entry }: Omit<ActivityEntry, 'at'>): void {
    this.db.sql
      .prepare(
        `INSERT INTO activity (at, kind, session_id, session_label, tool, method, path, status, decision, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now().toISOString(),
        entry.kind,
        entry.sessionId ?? null,
        // Unlabelled sessions have an empty label: store null so readers fall back to the id.
        sessionLabel === '' ? null : (sessionLabel ?? null),
        entry.tool ?? null,
        entry.method ?? null,
        entry.path === undefined ? null : redact(entry.path),
        entry.status ?? null,
        entry.decision ?? null,
        redact(entry.detail),
      );
  }

  /** Most recent entries first. */
  recent(limit = DEFAULT_LIMIT): ActivityEntry[] {
    const rows = this.db.sql
      .prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?')
      .all(clampLimit(limit)) as unknown as ActivityRow[];
    return rows.map(toEntry);
  }

  /** Every entry of the given sessions, oldest first (e.g. all calls made by one agent run). */
  forSessions(sessionIds: readonly string[], limit = MAX_LIMIT): ActivityEntry[] {
    if (sessionIds.length === 0) return [];
    const marks = sessionIds.map(() => '?').join(', ');
    const rows = this.db.sql
      .prepare(`SELECT * FROM activity WHERE session_id IN (${marks}) ORDER BY id LIMIT ?`)
      .all(...sessionIds, clampLimit(limit)) as unknown as ActivityRow[];
    return rows.map(toEntry);
  }
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function toEntry(row: ActivityRow): ActivityEntry {
  const entry: ActivityEntry = { at: row.at, kind: row.kind, detail: row.detail };
  if (row.session_id !== null) entry.sessionId = row.session_id;
  if (row.session_label !== null) entry.sessionLabel = row.session_label;
  if (row.tool !== null) entry.tool = row.tool;
  if (row.method !== null) entry.method = row.method;
  if (row.path !== null) entry.path = row.path;
  if (row.status !== null) entry.status = row.status;
  if (row.decision !== null) entry.decision = row.decision;
  return entry;
}
