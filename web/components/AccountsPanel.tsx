'use client';

import { useState } from 'react';
import { formatDateTime } from '@/lib/format';
import type { Account } from '@/lib/types';
import type { PanelProps } from './AdminApp';
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

export function AccountsPanel({ api, data, refresh }: PanelProps) {
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

  const toolName = (id: string): string => data.tools.find((t) => t.id === id)?.name ?? id;
  const activeSessions = (accountId: string): number =>
    data.sessions.filter((s) => s.accountId === accountId && s.status === 'active').length;

  return (
    <section>
      <SectionHeader
        title="Tool accounts"
        description="Credentials for third-party tools. They are verified on connect and stored encrypted on disk; they never leave the gateway."
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
          Connect a GitHub account with a personal access token to get started.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.accounts.map((acc) => {
            const sessions = activeSessions(acc.id);
            return (
              <Card key={acc.id} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{acc.label}</h3>
                      <Badge tone="indigo">{toolName(acc.tool)}</Badge>
                    </div>
                    <p className="mt-0.5 text-sm text-slate-500">
                      Signed in as{' '}
                      <span className="font-medium text-slate-700">
                        {acc.identity.login ?? 'unknown'}
                      </span>
                      {acc.identity.name && ` (${acc.identity.name})`}
                    </p>
                  </div>
                  <Badge tone={sessions > 0 ? 'green' : 'slate'}>
                    {sessions} active session{sessions === 1 ? '' : 's'}
                  </Badge>
                </div>

                <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-slate-500">Token</dt>
                  <dd className="font-mono text-slate-700">
                    {acc.secretHint}{' '}
                    {acc.identity.tokenType && (
                      <span className="font-sans text-xs text-slate-500">
                        ({acc.identity.tokenType})
                      </span>
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

                <div className="mt-5 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busyId === acc.id}
                    onClick={() =>
                      void run(acc.id, () => api('POST', `/accounts/${acc.id}/verify`))
                    }
                  >
                    {busyId === acc.id ? 'Verifying…' : 'Re-verify'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setEditing({ mode: 'edit', account: acc });
                    }}
                  >
                    Edit / rotate token
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busyId === acc.id}
                    onClick={() => {
                      const warning =
                        sessions > 0
                          ? `\n\n${sessions} active session key(s) will be revoked.`
                          : '';
                      if (confirm(`Remove account "${acc.label}"?${warning}`)) {
                        void run(acc.id, () => api('DELETE', `/accounts/${acc.id}`));
                      }
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </Card>
            );
          })}
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
        {...{ api, data, refresh }}
      />
    </section>
  );
}

function AccountModal({
  editing,
  onClose,
  onSaved,
  refresh,
  api,
  data,
}: {
  editing: Editing;
  onClose: () => void;
  onSaved: () => Promise<void>;
} & Pick<PanelProps, 'api' | 'data' | 'refresh'>) {
  const existing = editing?.mode === 'edit' ? editing.account : null;
  const [tool, setTool] = useState(existing?.tool ?? data.tools[0]?.id ?? '');
  const toolDef = data.tools.find((t) => t.id === tool);
  const [method, setMethod] = useState<'sign-in' | 'token'>(
    !existing && toolDef?.signIn ? 'sign-in' : 'token',
  );
  const [label, setLabel] = useState(existing?.label ?? '');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signInTool = toolDef?.signIn ? { ...toolDef, signIn: toolDef.signIn } : null;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await api('PATCH', `/accounts/${existing.id}`, {
          label,
          ...(secret ? { secret } : {}),
        });
      } else {
        await api('POST', '/accounts', { tool, label, secret });
      }
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={editing !== null}
      title={existing ? `Edit “${existing.label}”` : 'Connect a tool account'}
      onClose={onClose}
    >
      {!existing && (
        <div className="mb-4 space-y-4">
          {data.tools.length > 1 && (
            <Field label="Tool">
              <Select
                value={tool}
                onChange={(e) => {
                  const next = data.tools.find((t) => t.id === e.target.value);
                  setTool(e.target.value);
                  setMethod(next?.signIn ? 'sign-in' : 'token');
                }}
              >
                {data.tools.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {signInTool && (
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 text-sm font-medium">
              {(
                [
                  ['sign-in', `Sign in with ${signInTool.name}`],
                  ['token', 'Paste a token'],
                ] as const
              ).map(([id, text]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setMethod(id);
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
          )}
        </div>
      )}

      {!existing && method === 'sign-in' && signInTool ? (
        <DeviceSignIn
          api={api}
          tool={signInTool}
          onConnected={onSaved}
          onSettingsChanged={refresh}
          onCancel={onClose}
        />
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field
            label="Label"
            hint="A name to recognise this account, e.g. “Personal” or “Work bot”."
          >
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
            hint={toolDef?.credentialHelp}
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
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Verifying…' : existing ? 'Save' : 'Verify & connect'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
