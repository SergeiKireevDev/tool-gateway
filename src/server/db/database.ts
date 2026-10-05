import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PRIVATE_DIR_MODE } from '../units.js';
import { MIGRATIONS } from './migrations.js';

export const IN_MEMORY = ':memory:';

/**
 * The gateway's queryable database (SQLite, `node:sqlite`): activity, agent runs, transcripts
 * and LLM usage. Secrets never go here (see `redact.ts`); they stay in the encrypted store.
 */
export class Database {
  private constructor(readonly sql: DatabaseSync) {}

  static open(file: string): Database {
    if (file !== IN_MEMORY)
      mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
    const sql = new DatabaseSync(file);
    sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const db = new Database(sql);
    db.migrate();
    return db;
  }

  /** Runs `fn` in a transaction: committed if it returns, rolled back if it throws. */
  transaction<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.sql.exec('COMMIT');
      return result;
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.sql.close();
  }

  private migrate(): void {
    const row = this.sql.prepare('PRAGMA user_version').get() as { user_version: number };
    for (const [index, migration] of MIGRATIONS.entries()) {
      const version = index + 1;
      if (version <= row.user_version) continue;
      this.transaction(() => {
        this.sql.exec(migration);
        this.sql.exec(`PRAGMA user_version = ${version}`);
      });
    }
  }
}
