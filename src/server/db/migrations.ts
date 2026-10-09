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

  // 3: agent launchpad runs, their transcript events and output files
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     member_name TEXT NOT NULL,
     schedule_id TEXT,
     harness TEXT NOT NULL,
     model TEXT,
     prompt TEXT NOT NULL,
     template_id TEXT NOT NULL,
     template_name TEXT NOT NULL,
     account_ids TEXT NOT NULL,
     run_token_hash TEXT NOT NULL,
     session_id TEXT,
     vm_id TEXT,
     status TEXT NOT NULL,
     status_reason TEXT,
     timeout_seconds INTEGER NOT NULL,
     token_budget INTEGER,
     key_generation INTEGER,
     memory_in TEXT,
     memory_out TEXT,
     final_message TEXT,
     created_at TEXT NOT NULL,
     started_at TEXT,
     deadline TEXT,
     finished_at TEXT,
     outputs_bytes INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX runs_member ON runs (member_id, created_at);
   CREATE INDEX runs_status ON runs (status);
   CREATE TABLE run_events (
     run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     at TEXT NOT NULL,
     type TEXT NOT NULL,
     text TEXT NOT NULL,
     tool TEXT,
     call_id TEXT,
     data TEXT,
     PRIMARY KEY (run_id, seq)
   );
   CREATE TABLE run_outputs (
     run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     size INTEGER NOT NULL,
     content BLOB NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     PRIMARY KEY (run_id, path)
   );
   CREATE TABLE launch_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     settings TEXT NOT NULL
   );
   CREATE TABLE member_launch (
     member_id TEXT PRIMARY KEY,
     launch_enabled INTEGER NOT NULL,
     max_concurrent INTEGER
   );`,

  // 4: recurring agents
  `CREATE TABLE schedules (
     id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     member_name TEXT NOT NULL,
     name TEXT NOT NULL,
     prompt TEXT NOT NULL,
     harness TEXT NOT NULL,
     model TEXT,
     template_id TEXT NOT NULL,
     account_ids TEXT NOT NULL,
     preset TEXT NOT NULL,
     minute INTEGER NOT NULL,
     hour INTEGER NOT NULL,
     weekday INTEGER NOT NULL,
     day_of_month INTEGER NOT NULL,
     timezone TEXT NOT NULL,
     key_generation INTEGER NOT NULL,
     enabled INTEGER NOT NULL,
     stopped_reason TEXT,
     memory TEXT,
     next_run_at TEXT,
     last_run_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX schedules_member ON schedules (member_id);
   CREATE INDEX schedules_due ON schedules (enabled, next_run_at);`,

  // 5: inbound webhook deliveries (accepted and rejected)
  `CREATE TABLE webhook_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     webhook_id TEXT NOT NULL,
     at TEXT NOT NULL,
     accepted INTEGER NOT NULL,
     reason TEXT,
     event_type TEXT,
     payload TEXT
   );
   CREATE INDEX webhook_events_hook ON webhook_events (webhook_id, id);`,

  // 6: agents launched by webhook deliveries
  `CREATE TABLE triggers (
     id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     member_name TEXT NOT NULL,
     name TEXT NOT NULL,
     webhook_id TEXT NOT NULL,
     event_types TEXT NOT NULL,
     instructions TEXT NOT NULL,
     harness TEXT NOT NULL,
     model TEXT,
     template_id TEXT NOT NULL,
     account_ids TEXT NOT NULL,
     key_generation INTEGER NOT NULL,
     enabled INTEGER NOT NULL,
     stopped_reason TEXT,
     last_run_id TEXT,
     last_fired_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX triggers_member ON triggers (member_id);
   CREATE INDEX triggers_webhook ON triggers (webhook_id, enabled);
   ALTER TABLE runs ADD COLUMN trigger_id TEXT;
   ALTER TABLE runs ADD COLUMN instructions TEXT;`,

  // 7: deterministic trigger filters (contains / status changed to / assigned to)
  `ALTER TABLE triggers ADD COLUMN filters TEXT NOT NULL DEFAULT '{}';`,

  // 8: the model API a launch asked for (templates granting a harness several)
  `ALTER TABLE runs ADD COLUMN provider TEXT;
   ALTER TABLE schedules ADD COLUMN provider TEXT;
   ALTER TABLE triggers ADD COLUMN provider TEXT;`,
];
