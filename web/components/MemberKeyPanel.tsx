'use client';

import { useState } from 'react';
import { formatDateTime, formatDuration } from '@/lib/format';
import type { PanelProps } from './AdminApp';
import { GrantList } from './GrantList';
import { MemberKeyReveal } from './MembersPanel';
import { Button, Card, ErrorBanner, SectionHeader } from './ui';

/** Member portal: the member's own key (for scripts) and the templates it gives access to. */
export function MemberKeyPanel({ api, data, refresh }: PanelProps) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const self = data.self;
  if (!self) return null;

  const rotate = async (): Promise<void> => {
    const warning = data.sessions.some((s) => s.status === 'active')
      ? ' Your active session keys will be revoked too.'
      : '';
    if (!confirm(`Create a new member key? The current key stops working.${warning}`)) return;
    setError(null);
    try {
      const res = await api<{ key: string }>('POST', '/rotate-key');
      setRevealed(res.key);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section>
      <SectionHeader
        title="Member key"
        description="Scripts, agents and CI jobs use your member key to request session keys on your behalf, with the same limits as you. The key itself cannot call tools."
        action={<Button onClick={() => void rotate()}>New member key</Button>}
      />
      <div className="mb-4">
        <ErrorBanner message={error} />
      </div>

      <Card className="p-5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-slate-500">Current key</dt>
          <dd className="font-mono text-slate-700">{self.keyHint}…</dd>
          <dt className="text-slate-500">Expires</dt>
          <dd className="text-slate-700">
            {self.expiresAt ? formatDateTime(self.expiresAt) : 'Never'}
          </dd>
        </dl>
        <p className="mt-4 text-xs text-slate-500">
          The full key is only shown when it is created. Lost it? Create a new one: the old key and
          the session keys it issued stop working.
        </p>
      </Card>

      <h3 className="mt-8 mb-3 text-sm font-semibold text-slate-700">Templates available to you</h3>
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

      {revealed && (
        <MemberKeyReveal
          revealed={{
            key: revealed,
            member: { templateIds: self.templates.map((t) => t.id), email: self.email },
            rotated: true,
          }}
          onClose={() => {
            setRevealed(null);
          }}
        />
      )}
    </section>
  );
}
