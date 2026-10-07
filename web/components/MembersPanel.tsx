'use client';

import { useState } from 'react';
import { formatDateTime, formatRelative } from '@/lib/format';
import { grantsScope } from '@/lib/grants';
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
  const canCreate = data.templates.length > 0;

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
        description="Members get short-lived session keys for the templates you choose, on accounts they connect themselves (they sign in with Google using the email you set) or shared accounts you grant. Their member key lets scripts do the same, but cannot call tools or the admin API."
        action={
          <Button
            disabled={!canCreate}
            title={canCreate ? undefined : 'Create a template first'}
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
          Add a teammate by their Google email, or create a key-only member for an agent or CI job.
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
  const ownAccounts = data.accounts.filter(
    (a) => a.owner.kind === 'member' && a.owner.memberId === m.id,
  );
  const expired = m.expired || (m.expiresAt !== null && Date.parse(m.expiresAt) <= now);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{m.name}</h3>
            <Badge tone={expired ? 'red' : 'green'}>{expired ? 'expired' : 'active'}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-slate-500">
            {m.email ?? 'No sign-in (key only)'}
            <span className="ml-2 font-mono text-xs">{m.keyHint}…</span>
          </p>
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

      <div className="mt-4 grid gap-4 text-sm md:grid-cols-3">
        <ChipList
          title="Templates"
          items={templates.map((t) => ({ id: t.id, label: t.name }))}
          empty="None: this member cannot request keys"
        />
        <ChipList
          title="Own accounts"
          items={ownAccounts.map((a) => ({
            id: a.id,
            label: `${a.label} (${a.identity.login ?? a.tool})`,
          }))}
          empty={m.email ? 'None connected yet' : 'Key-only member'}
        />
        <ChipList
          title="Shared accounts granted"
          items={accounts.map((a) => ({
            id: a.id,
            label: `${a.label} (${a.identity.login ?? a.tool})`,
          }))}
          empty="None"
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

function ChipList({
  title,
  items,
  empty,
}: {
  title: string;
  items: { id: string; label: string }[];
  empty: string;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">{title}</p>
      {items.length === 0 ? (
        <span className="text-slate-500">{empty}</span>
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
  const [email, setEmail] = useState(existing?.email ?? '');
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
      email: email.trim() ? email.trim() : null,
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
        <Field label="Name" hint="Who or what this member is, e.g. “Alice” or “release-agent”.">
          <Input
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </Field>
        <Field
          label="Google email (optional)"
          hint="The member signs in with this Google account to connect their own accounts and get keys. Leave empty for a key-only member (scripts, CI)."
        >
          <Input
            type="email"
            autoComplete="off"
            placeholder="alice@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
        </Field>
        <CheckList
          legend="Templates it may request keys from"
          items={data.templates.map((t) => ({
            id: t.id,
            label: t.name,
            hint: grantsScope(t.grants, data.tools),
          }))}
          selected={templateIds}
          onChange={setTemplateIds}
        />
        <CheckList
          legend="Shared accounts it may also use (optional)"
          empty="No shared accounts: connect one in Accounts to grant it."
          items={data.accounts
            .filter((a) => a.owner.kind === 'shared')
            .map((a) => ({
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
          <Button type="submit" disabled={busy || !templateIds.length}>
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
  empty,
}: {
  legend: string;
  empty?: string;
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
      {items.length === 0 && empty && <p className="mt-1 text-xs text-slate-500">{empty}</p>}
      <div className="mt-2 grid max-h-56 gap-2 overflow-y-auto p-1 sm:grid-cols-2">
        {items.map((item) => {
          const checked = selected.includes(item.id);
          return (
            <label
              key={item.id}
              className={`flex cursor-pointer gap-3 rounded-lg p-3 ring-1 transition ${
                checked ? 'bg-brand-50 ring-brand-300' : 'ring-slate-200 hover:bg-slate-50'
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-brand-600"
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

export function MemberKeyReveal({
  revealed,
  onClose,
}: {
  revealed: { key: string; member: Pick<Member, 'templateIds' | 'email'>; rotated: boolean };
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
        {!rotated && member.email && (
          <p className="text-sm text-slate-600">
            {member.email} can also sign in at <strong>{origin}</strong> with Google to connect
            their own accounts and manage keys.
          </p>
        )}
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
