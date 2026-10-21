'use client';

import { useState } from 'react';
import type { Api } from '@/lib/api';
import type { Run } from '@/lib/launchpad';

/** Runs per page: the API's default list size. */
export const RUNS_PAGE = 50;

/** Older runs loaded for one runs query; another query (filter) starts over. */
interface Pages {
  query: string;
  runs: Run[];
  done: boolean;
}

/**
 * Pages back through every past run, past the newest page that `latest` polls. Runs are never
 * deleted, so this reaches all of them.
 */
export function useOlderRuns(api: Api, query: string, latest: Run[] | null) {
  const [pages, setPages] = useState<Pages | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const older = pages?.query === query ? pages : null;

  const fresh = new Set((latest ?? []).map((r) => r.id));
  // Runs that left the newest page as new ones came in stay listed, in place.
  const runs = latest && [...latest, ...(older?.runs ?? []).filter((r) => !fresh.has(r.id))];
  const hasMore = older ? !older.done : (latest?.length ?? 0) >= RUNS_PAGE;

  const loadOlder = (): void => {
    const last = runs?.at(-1);
    if (!runs || !last || loading) return;
    const params = new URLSearchParams(query);
    params.set('before', last.createdAt);
    params.set('beforeId', last.id);
    params.set('limit', String(RUNS_PAGE));
    setLoading(true);
    api<Run[]>('GET', `/launchpad/runs?${params.toString()}`)
      .then(
        (page) => {
          setPages({ query, runs: [...runs, ...page], done: page.length < RUNS_PAGE });
          setError(null);
        },
        (err: unknown) => {
          setError((err as Error).message);
        },
      )
      .finally(() => {
        setLoading(false);
      });
  };

  return { runs, hasMore, loading, error, loadOlder };
}
