/**
 * Schema migrations, applied in order; the database's `user_version` is the number applied.
 * Never edit a released migration: append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: activity log (was an in-memory ring buffer)
  `CREATE TABLE activity (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     session_id TEXT,
     session_label TEXT,
     tool TEXT,
     method TEXT,
     path TEXT,
     status INTEGER,
     decision TEXT,
     detail TEXT NOT NULL
   );
   CREATE INDEX activity_session ON activity (session_id, id);`,

  // 2: tokens used by LLM calls, per session key (token budgets, usage dashboards)
  `CREATE TABLE llm_usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     session_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     cache_read_tokens INTEGER NOT NULL,
     cache_write_tokens INTEGER NOT NULL
   );
   CREATE INDEX llm_usage_session ON llm_usage (session_id);`,
];
