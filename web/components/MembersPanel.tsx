'use client';

import { useState } from 'react';
import { formatDateTime, formatRelative } from '@/lib/format';
import type { Member, MemberInput } from '@/lib/types';
import { MS_PER_SECOND, SECONDS_PER_DAY } from '@/lib/units';
import type { GatewayData, PanelProps } from './AdminApp';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Modal,
  SectionHeader,
  Select,
  Snippet,
  useNow,
} from './ui';

type Editing = { mode: 'create' } | { mode: 'edit'; member: Member } | null;
type Revealed = { key: string; member: Member; rotated: boolean } | null;

export function MembersPanel({ api, data, refresh }: PanelProps) {
  const now = useNow();
  const [editing, setEditing] = useState<Editing>(null);
  const [revealed, setRevealed] = useState<Revealed>(null);
  const [error, setError] = useState<string | null>(null);
  const canCreate = data.templates.length > 0 && data.accounts.length > 0;

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const rotate = (m: Member): void => {
    const warning =
      m.activeSessions > 0 ? ` Its ${m.activeSessions} active session key(s) will be revoked.` : '';
    if (!confirm(`Replace the key of "${m.name}"? The current key stops working.${warning}`)) {
      return;
    }
    void run(async () => {
      const res = await api<{ key: string; member: Member }>('POST', `/members/${m.id}/rotate`);
      setRevealed({ ...res, rotated: true });
    });
  };

  const remove = (m: Member): void => {
    const warning =
      m.activeSessions > 0 ? `\n\n${m.activeSessions} active session key(s) will be revoked.` : '';
    if (confirm(`Delete member "${m.name}"?${warning}`)) {
      void run(() => api('DELETE', `/members/${m.id}`));
    }
  };

  return (
    <section>
      <SectionHeader
        title="Members"
        description="A member key lets a script or agent request its own session keys, but only from the templates and accounts you allow here. The member key itself cannot call tools or the admin API."
        action={
          <Button
            disabled={!canCreate}
            title={canCreate ? undefined : 'Create a template and connect an account first'}
            onClick={() => {
              setEditing({ mode: 'create' });
            }}
          >
            + New member
          </Button>
        }
      />
      <div className="mb-4">
        <ErrorBanner message={error} />
      </div>

      {data.members.length === 0 ? (
        <EmptyState title="No members yet">
          Create one to let an agent or CI job request its own short-lived session keys.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {data.members.map((m) => (
            <MemberCard
              key={m.id}
              member={m}
              data={data}
              now={now}
              onEdit={() => {
                setEditing({ mode: 'edit', member: m });
              }}
              onRotate={() => {
                rotate(m);
              }}
              onDelete={() => {
                remove(m);
              }}
            />
          ))}
        </div>
      )}

      {editing && (
        <MemberModal
          api={api}
          data={data}
          existing={editing.mode === 'edit' ? editing.member : null}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={async (created) => {
            setEditing(null);
            if (created) setRevealed({ ...created, rotated: false });
            await refresh();
          }}
        />
      )}
      {revealed && (
        <MemberKeyReveal
          revealed={revealed}
          onClose={() => {
            setRevealed(null);
          }}
        />
      )}
    </section>
  );
}

function MemberCard({
  member: m,
  data,
  now,
  onEdit,
  onRotate,
  onDelete,
}: {
  member: Member;
  data: GatewayData;
  now: number;
  onEdit: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const templates = data.templates.filter((t) => m.templateIds.includes(t.id));
  const accounts = data.accounts.filter((a) => m.accountIds.includes(a.id));
  const expired = m.expired || (m.expiresAt !== null && Date.parse(m.expiresAt) <= now);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{m.name}</h3>
            <Badge tone={expired ? 'red' : 'green'}>{expired ? 'expired' : 'active'}</Badge>
          </div>
          <p className="mt-0.5 font-mono text-xs text-slate-500">{m.keyHint}…</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button variant="secondary" size="sm" onClick={onRotate}>
            Rotate key
          </Button>
          <Button variant="danger" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 text-sm md:grid-cols-2">
        <ChipList title="Templates" items={templates.map((t) => ({ id: t.id, label: t.name }))} />
        <ChipList
          title="Accounts"
          items={accounts.map((a) => ({
            id: a.id,
            label: `${a.label} (${a.identity.login ?? a.tool})`,
          }))}
        />
      </div>
      <p className="mt-4 text-xs text-slate-500">
        {m.expiresAt ? `Expires ${formatRelative(m.expiresAt, now)}` : 'Never expires'} ·{' '}
        {m.activeSessions} active session key{m.activeSessions === 1 ? '' : 's'} ·{' '}
        {m.lastUsedAt ? `last used ${formatRelative(m.lastUsedAt, now)}` : 'never used'}
      </p>
    </Card>
  );
}

function ChipList({ title, items }: { title: string; items: { id: string; label: string }[] }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">{title}</p>
      {items.length === 0 ? (
        <span className="text-amber-700">None: this member cannot request keys</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((i) => (
            <Badge key={i.id}>{i.label}</Badge>
          ))}
        </div>
      )}
    </div>
  );
}

const EXPIRY_PRESETS = [
  { value: 'never', label: 'Never', days: null },
  { value: '30', label: 'In 30 days', days: 30 },
  { value: '90', label: 'In 90 days', days: 90 },
  { value: '365', label: 'In 1 year', days: 365 },
] as const;
const KEEP_EXPIRY = 'keep';

function expiryFromChoice(choice: string, existing: Member | null): string | null {
  if (choice === KEEP_EXPIRY) return existing?.expiresAt ?? null;
  const preset = EXPIRY_PRESETS.find((p) => p.value === choice);
  if (!preset?.days) return null;
  return new Date(Date.now() + preset.days * SECONDS_PER_DAY * MS_PER_SECOND).toISOString();
}

function MemberModal({
  api,
  data,
  existing,
  onClose,
  onSaved,
}: Pick<PanelProps, 'api' | 'data'> & {
  existing: Member | null;
  onClose: () => void;
  onSaved: (created: { key: string; member: Member } | null) => Promise<void>;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [templateIds, setTemplateIds] = useState<string[]>(existing?.templateIds ?? []);
  const [accountIds, setAccountIds] = useState<string[]>(existing?.accountIds ?? []);
  const [expiry, setExpiry] = useState<string>(existing ? KEEP_EXPIRY : 'never');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const body: MemberInput = {
      name,
      templateIds,
      accountIds,
      expiresAt: expiryFromChoice(expiry, existing),
    };
    try {
      if (existing) {
        await api('PUT', `/members/${existing.id}`, body);
        await onSaved(null);
      } else {
        await onSaved(await api<{ key: string; member: Member }>('POST', '/members', body));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal wide open title={existing ? `Edit “${existing.name}”` : 'New member'} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" hint="Who or what will use this key, e.g. “release-agent” or “ci”.">
          <Input
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </Field>
        <CheckList
          legend="Templates it may request keys from"
          items={data.templates.map((t) => ({
            id: t.id,
            label: t.name,
            hint: t.resources.length ? t.resources.join(', ') : 'all repositories',
          }))}
          selected={templateIds}
          onChange={setTemplateIds}
        />
        <CheckList
          legend="Accounts those keys may use"
          items={data.accounts.map((a) => ({
            id: a.id,
            label: a.label,
            hint: `${a.tool} · ${a.identity.login ?? 'unknown'}`,
          }))}
          selected={accountIds}
          onChange={setAccountIds}
        />
        <Field label="Member key expires">
          <Select
            value={expiry}
            onChange={(e) => {
              setExpiry(e.target.value);
            }}
          >
            {existing && (
              <option value={KEEP_EXPIRY}>
                Keep current ({existing.expiresAt ? formatDateTime(existing.expiresAt) : 'never'})
              </option>
            )}
            {EXPIRY_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorBanner message={error} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !templateIds.length || !accountIds.length}>
            {existing ? 'Save changes' : 'Create member'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CheckList({
  legend,
  items,
  selected,
  onChange,
}: {
  legend: string;
  items: { id: string; label: string; hint: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string): void => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  return (
    <fieldset>
      <legend className="text-sm font-medium text-slate-700">{legend}</legend>
      <div className="mt-2 grid max-h-56 gap-2 overflow-y-auto p-1 sm:grid-cols-2">
        {items.map((item) => {
          const checked = selected.includes(item.id);
          return (
            <label
              key={item.id}
              className={`flex cursor-pointer gap-3 rounded-lg p-3 ring-1 transition ${
                checked ? 'bg-indigo-50 ring-indigo-300' : 'ring-slate-200 hover:bg-slate-50'
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-indigo-600"
                checked={checked}
                onChange={() => {
                  toggle(item.id);
                }}
              />
              <span>
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="block text-xs text-slate-500">{item.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function MemberKeyReveal({
  revealed,
  onClose,
}: {
  revealed: NonNullable<Revealed>;
  onClose: () => void;
}) {
  const origin = window.location.origin;
  const { key, member, rotated } = revealed;
  const discover = `curl -H "Authorization: Bearer $GATEWAY_MEMBER_KEY" ${origin}/api/member`;
  const request = [
    `curl -X POST ${origin}/api/sessions \\`,
    '  -H "Authorization: Bearer $GATEWAY_MEMBER_KEY" \\',
    "  -H 'Content-Type: application/json' \\",
    `  -d '{"templateId":"${member.templateIds[0] ?? '<template id>'}","ttlSeconds":1800,"label":"my job"}'`,
  ].join('\n');

  return (
    <Modal wide open title={rotated ? 'New member key' : 'Member created'} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          Copy this key now: it is not stored and will not be shown again.
          {rotated && ' The previous key and the session keys it issued no longer work.'}
        </div>
        <div className="flex items-center gap-2">
          <code className="block flex-1 overflow-x-auto rounded-md bg-slate-900 px-3 py-2 font-mono text-sm whitespace-nowrap text-emerald-300">
            {key}
          </code>
          <CopyButton value={key} />
        </div>
        <Snippet title="Environment" value={`export GATEWAY_MEMBER_KEY=${key}`} />
        <Snippet title="See allowed templates and accounts" value={discover} />
        <Snippet title="Request a session key" value={request} />
        <p className="text-xs text-slate-500">
          The response contains a <code className="font-mono">gws_…</code> session key to use
          against <code className="font-mono">{origin}/proxy/&lt;tool&gt;</code>. Members can list
          their keys with <code className="font-mono">GET /api/sessions</code> and revoke them with{' '}
          <code className="font-mono">POST /api/sessions/&lt;id&gt;/revoke</code>.
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
