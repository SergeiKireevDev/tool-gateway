import type { Database } from './db/database.js';
import type { TokenUsage } from './tools/types.js';

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Every token counted against a budget: input + output + cache reads + cache writes. */
  total: number;
}

export interface ModelUsage extends UsageTotals {
  provider: string;
  model: string;
}

const SUM_COLUMNS = `COUNT(*) AS calls,
  COALESCE(SUM(input_tokens), 0) AS input,
  COALESCE(SUM(output_tokens), 0) AS output,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
  COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite`;

type SumRow = Omit<UsageTotals, 'total'>;

const withTotal = <T extends SumRow>(row: T): T & { total: number } => ({
  ...row,
  total: row.input + row.output + row.cacheRead + row.cacheWrite,
});

/** Tokens used by LLM calls through the proxy, per session key. */
export class LlmUsageLog {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(sessionId: string, provider: string, usage: TokenUsage): void {
    this.db.sql
      .prepare(
        `INSERT INTO llm_usage (at, session_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now().toISOString(),
        sessionId,
        provider,
        usage.model,
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
      );
  }

  totalsFor(sessionIds: readonly string[]): UsageTotals {
    const marks = sessionIds.map(() => '?').join(', ');
    const row = this.db.sql
      .prepare(`SELECT ${SUM_COLUMNS} FROM llm_usage WHERE session_id IN (${marks || "''"})`)
      .get(...sessionIds) as unknown as SumRow;
    return withTotal(row);
  }

  /** Usage per provider and model for the given sessions, or for every session when null. */
  byModel(sessionIds: readonly string[] | null): ModelUsage[] {
    const where =
      sessionIds === null
        ? ''
        : `WHERE session_id IN (${sessionIds.map(() => '?').join(', ') || "''"})`;
    const rows = this.db.sql
      .prepare(
        `SELECT provider, model, ${SUM_COLUMNS} FROM llm_usage ${where} GROUP BY provider, model ORDER BY provider, model`,
      )
      .all(...(sessionIds ?? [])) as unknown as (SumRow & { provider: string; model: string })[];
    return rows.map(withTotal);
  }
}
