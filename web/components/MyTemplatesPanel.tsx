'use client';

import { formatDateTime, formatDuration } from '@/lib/format';
import type { PanelProps } from './AdminApp';
import { GrantList } from './GrantList';
import { Card, SectionHeader } from './ui';

/**
 * Member portal: the templates the member may use. Members never see or rotate their member key:
 * they sign in with Google and launch agents; only the admin manages member keys.
 */
export function MyTemplatesPanel({ data }: PanelProps) {
  const self = data.self;
  if (!self) return null;

  return (
    <section>
      <SectionHeader
        title="My templates"
        description={`What your agents and session keys may be allowed to do.${
          self.expiresAt ? ` Your access ends ${formatDateTime(self.expiresAt)}.` : ''
        }`}
      />
      <div className="grid gap-3 md:grid-cols-2">
        {self.templates.map((t) => (
          <Card key={t.id} className="p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{t.name}</span>
              <span className="font-mono text-xs text-slate-400">{t.id}</span>
            </div>
            {t.description && <p className="mt-1 text-sm text-slate-500">{t.description}</p>}
            <div className="mt-3">
              <GrantList grants={t.grants} tools={data.tools} />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Keys last up to {formatDuration(t.maxTtlSeconds)}
              {t.grants.length > 1 && ', with one of your accounts for each tool'}
            </p>
          </Card>
        ))}
      </div>
    </section>
  );
}
