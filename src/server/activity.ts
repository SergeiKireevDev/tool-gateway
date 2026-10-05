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

/** In-memory ring buffer of recent activity, shown in the admin UI. */
export class ActivityLog {
  private readonly entries: ActivityEntry[] = [];

  constructor(private readonly capacity = 500) {}

  add({ sessionLabel, ...entry }: Omit<ActivityEntry, 'at'>): void {
    // Unlabelled sessions have an empty label: omit it so readers fall back to the session id.
    this.entries.push({
      at: new Date().toISOString(),
      ...entry,
      ...(sessionLabel ? { sessionLabel } : {}),
    });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  recent(limit = 200): ActivityEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}
