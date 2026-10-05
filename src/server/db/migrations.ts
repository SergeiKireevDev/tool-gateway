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
];
