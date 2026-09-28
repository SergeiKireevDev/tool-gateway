'use client';

import { useState } from 'react';
import { formatDateTime } from '@/lib/format';
import type { Account, Tool } from '@/lib/types';
import type { PanelProps, Viewer } from './AdminApp';
import { DeviceSignIn } from './DeviceSignIn';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Modal,
  SectionHeader,
  Select,
} from './ui';

type Editing = { mode: 'create' } | { mode: 'edit'; account: Account } | null;

interface AccountActions {
  edit: boolean;
  verify: boolean;
  remove: boolean;
}

const NO_ACTIONS: AccountActions = { edit: false, verify: false, remove: false };
const ALL_ACTIONS: AccountActions = { edit: true, verify: true, remove: true };

/**
 * What the viewer may do with an account (mirrors the server rules): members manage only their
 * own accounts; the admin manages shared accounts and can re-verify or remove member ones.
 */
function accountActions(viewer: Viewer, acc: Account): AccountActions {
  if (viewer.role === 'member') {
    const own = acc.owner.kind === 'member' && acc.owner.memberId === viewer.memberId;
    return own ? ALL_ACTIONS : NO_ACTIONS;
  }
  return { edit: acc.owner.kind === 'shared', verify: true, remove: true };
}

const DESCRIPTIONS: Record<Viewer['role'], string> = {
  admin:
    'Shared accounts you connect can be granted to members. Members also connect their own accounts, which only they can use: you can re-verify or remove those, not change them. Credentials are stored encrypted and never leave the gateway.',
  member:
    'Accounts you connect are private to you: only your session keys can use them. Shared accounts granted by the admin are listed too. Credentials are stored encrypted and never leave the gateway.',
};

export function AccountsPanel({ api, data, refresh, viewer }: PanelProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <SectionHeader
        title={viewer.role === 'member' ? 'My accounts' : 'Tool accounts'}
        description={DESCRIPTIONS[viewer.role]}
        action={
          <Button
            onClick={() => {
              setEditing({ mode: 'create' });
            }}
          >
            + Connect account
          </Button>
        }
      />
      <div className="mb-4">
        <ErrorBanner message={error} />
      </div>

      {data.accounts.length === 0 ? (
        <EmptyState title="No accounts connected yet">
          Connect a GitHub account to get started.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.accounts.map((acc) => (
            <AccountCard
              key={acc.id}
              account={acc}
              data={data}
              viewer={viewer}
              busy={busyId === acc.id}
              onVerify={() => void run(acc.id, () => api('POST', `/accounts/${acc.id}/verify`))}
              onEdit={() => {
                setEditing({ mode: 'edit', account: acc });
              }}
              onRemove={() => void run(acc.id, () => api('DELETE', `/accounts/${acc.id}`))}
            />
          ))}
        </div>
      )}

      <AccountModal
        key={editing?.mode === 'edit' ? editing.account.id : (editing?.mode ?? 'closed')}
        editing={editing}
        onClose={() => {
          setEditing(null);
        }}
        onSaved={async () => {
          setEditing(null);
          await refresh();
        }}
        {...{ api, data, refresh, viewer }}
      />
    </section>
  );
}

function OwnerBadge({ account, viewer }: { account: Account; viewer: Viewer }) {
  if (account.owner.kind === 'shared') {
    return viewer.role === 'member' ? <Badge>shared by admin</Badge> : <Badge>shared</Badge>;
  }
  return viewer.role === 'admin' ? <Badge tone="amber">{account.owner.memberName}</Badge> : null;
}

function TokenDetails({ account: acc }: { account: Account }) {
  return (
    <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      <dt className="text-slate-500">Token</dt>
      <dd className="font-mono text-slate-700">
        {acc.secretHint}{' '}
        {acc.identity.tokenType && (
          <span className="font-sans text-xs text-slate-500">({acc.identity.tokenType})</span>
        )}
      </dd>
      {acc.identity.scopes && (
        <>
          <dt className="text-slate-500">Scopes</dt>
          <dd className="text-slate-700">{acc.identity.scopes}</dd>
        </>
      )}
      {acc.identity.tokenExpires && (
        <>
          <dt className="text-slate-500">Token expires</dt>
          <dd className="text-slate-700">{acc.identity.tokenExpires}</dd>
        </>
      )}
      <dt className="text-slate-500">Last verified</dt>
      <dd className="text-slate-700">{formatDateTime(acc.lastVerifiedAt)}</dd>
    </dl>
  );
}

function AccountCard({
  account: acc,
  data,
  viewer,
  busy,
  onVerify,
  onEdit,
  onRemove,
}: {
  account: Account;
  data: PanelProps['data'];
  viewer: Viewer;
  busy: boolean;
  onVerify: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const can = accountActions(viewer, acc);
  const toolName = data.tools.find((t) => t.id === acc.tool)?.name ?? acc.tool;
  const sessions = data.sessions.filter(
    (s) => s.accountId === acc.id && s.status === 'active',
  ).length;

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{acc.label}</h3>
            <Badge tone="indigo">{toolName}</Badge>
            <OwnerBadge account={acc} viewer={viewer} />
          </div>
          <p className="mt-0.5 text-sm text-slate-500">
            Signed in as{' '}
            <span className="font-medium text-slate-700">{acc.identity.login ?? 'unknown'}</span>
            {acc.identity.name && ` (${acc.identity.name})`}
          </p>
        </div>
        <Badge tone={sessions > 0 ? 'green' : 'slate'}>
          {sessions} active session{sessions === 1 ? '' : 's'}
        </Badge>
      </div>

      <TokenDetails account={acc} />

      {(can.verify || can.edit || can.remove) && (
        <div className="mt-5 flex flex-wrap gap-2">
          {can.verify && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={onVerify}>
              {busy ? 'Verifying…' : 'Re-verify'}
            </Button>
          )}
          {can.edit && (
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit / rotate token
            </Button>
          )}
          {can.remove && (
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => {
                const warning =
                  sessions > 0 ? `\n\n${sessions} active session key(s) will be revoked.` : '';
                if (confirm(`Remove account "${acc.label}"?${warning}`)) onRemove();
              }}
            >
              Remove
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function AccountModal({
  editing,
  onClose,
  onSaved,
  refresh,
  api,
  data,
  viewer,
}: {
  editing: Editing;
  onClose: () => void;
  onSaved: () => Promise<void>;
} & Pick<PanelProps, 'api' | 'data' | 'refresh' | 'viewer'>) {
  const existing = editing?.mode === 'edit' ? editing.account : null;
  return (
    <Modal
      open={editing !== null}
      title={existing ? `Edit “${existing.label}”` : 'Connect a tool account'}
      onClose={onClose}
    >
      {existing ? (
        <TokenAccountForm
          api={api}
          tool={data.tools.find((t) => t.id === existing.tool)}
          existing={existing}
          onSaved={onSaved}
          onCancel={onClose}
        />
      ) : (
        <ConnectAccount
          api={api}
          tools={data.tools}
          onSaved={onSaved}
          onCancel={onClose}
          refresh={refresh}
          canConfigure={viewer.role === 'admin'}
        />
      )}
    </Modal>
  );
}

type ConnectMethod = 'sign-in' | 'token';

const defaultMethod = (tool: Tool | undefined): ConnectMethod =>
  tool?.signIn ? 'sign-in' : 'token';

/** New account: pick the tool and how to connect it (interactive sign-in or pasted token). */
function ConnectAccount({
  api,
  tools,
  onSaved,
  onCancel,
  refresh,
  canConfigure,
}: {
  api: PanelProps['api'];
  tools: Tool[];
  onSaved: () => Promise<void>;
  onCancel: () => void;
  refresh: () => Promise<void>;
  /** Only the admin can set up the tool's OAuth app; members only get sign-in once it exists. */
  canConfigure: boolean;
}) {
  const available = (t: Tool | undefined): Tool | undefined =>
    t?.signIn && (canConfigure || t.signIn.oauthClientId) ? t : undefined;
  const [toolId, setToolId] = useState(tools[0]?.id ?? '');
  const tool = tools.find((t) => t.id === toolId);
  const offered = available(tool);
  const [method, setMethod] = useState<ConnectMethod>(defaultMethod(offered));
  const signInTool = offered?.signIn ? { ...offered, signIn: offered.signIn } : null;

  return (
    <>
      <div className="mb-4 space-y-4">
        {tools.length > 1 && (
          <Field label="Tool">
            <Select
              value={toolId}
              onChange={(e) => {
                setToolId(e.target.value);
                setMethod(defaultMethod(available(tools.find((t) => t.id === e.target.value))));
              }}
            >
              {tools.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {signInTool && (
          <MethodTabs toolName={signInTool.name} method={method} onChange={setMethod} />
        )}
      </div>
      {method === 'sign-in' && signInTool ? (
        <DeviceSignIn
          api={api}
          tool={signInTool}
          onConnected={onSaved}
          onSettingsChanged={refresh}
          onCancel={onCancel}
          canConfigure={canConfigure}
        />
      ) : (
        <TokenAccountForm
          key={toolId}
          api={api}
          tool={tool}
          existing={null}
          onSaved={onSaved}
          onCancel={onCancel}
        />
      )}
    </>
  );
}

function MethodTabs({
  toolName,
  method,
  onChange,
}: {
  toolName: string;
  method: ConnectMethod;
  onChange: (method: ConnectMethod) => void;
}) {
  const tabs: [ConnectMethod, string][] = [
    ['sign-in', `Sign in with ${toolName}`],
    ['token', 'Paste a token'],
  ];
  return (
    <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-sm font-medium">
      {tabs.map(([id, text]) => (
        <button
          key={id}
          type="button"
          onClick={() => {
            onChange(id);
          }}
          className={`rounded-md px-3 py-1.5 transition ${
            method === id
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Connect an account with a pasted token, or edit an existing one (label / token rotation). */
function TokenAccountForm({
  api,
  tool,
  existing,
  onSaved,
  onCancel,
}: {
  api: PanelProps['api'];
  tool: Tool | undefined;
  existing: Account | null;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(existing?.label ?? '');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = (): Promise<unknown> =>
    existing
      ? api('PATCH', `/accounts/${existing.id}`, { label, ...(secret ? { secret } : {}) })
      : api('POST', '/accounts', { tool: tool?.id, label, secret });

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await save();
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const idleLabel = existing ? 'Save' : 'Verify & connect';

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Label" hint="A name to recognise this account, e.g. “Personal” or “Work bot”.">
        <Input
          required
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
          }}
        />
      </Field>
      <Field
        label={existing ? 'New token (leave empty to keep the current one)' : 'Access token'}
        hint={tool?.credentialHelp}
      >
        <Input
          type="password"
          autoComplete="off"
          required={!existing}
          value={secret}
          placeholder={existing ? existing.secretHint : 'github_pat_…'}
          onChange={(e) => {
            setSecret(e.target.value);
          }}
        />
      </Field>
      <ErrorBanner message={error} />
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Verifying…' : idleLabel}
        </Button>
      </div>
    </form>
  );
}
