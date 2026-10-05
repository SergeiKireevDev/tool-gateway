'use client';

import { useState } from 'react';
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format';
import { grantsScope, toolName } from '@/lib/grants';
import type {
  Account,
  Session,
  SessionIssuer,
  SessionStatus,
  TemplateSummary,
  Tool,
} from '@/lib/types';
import { DEFAULT_TTL_SECONDS } from '@/lib/units';
import type { PanelProps } from './AdminApp';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  DurationInput,
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

const STATUS_TONE: Record<SessionStatus, 'green' | 'slate' | 'red'> = {
  active: 'green',
  expired: 'slate',
  revoked: 'red',
};

const SESSION_DESCRIPTIONS: Record<PanelProps['viewer']['role'], string> = {
  admin:
    "Short-lived keys that grant a template's permissions, on one account per tool. Hand them to scripts or agents; they stop working when the TTL expires or when revoked. Keys issued by members are listed too.",
  member:
    "Short-lived keys that grant one of your templates' permissions, on one of your accounts per tool. Hand them to scripts or agents; they stop working when the TTL expires or when revoked.",
};

export function SessionsPanel({ api, data, refresh, viewer }: PanelProps) {
  const now = useNow();
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<{ key: string; session: Session } | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountLabels = (s: Session): string =>
    s.grants
      .map((g) => data.accounts.find((a) => a.id === g.accountId)?.label ?? 'removed account')
      .join(', ');
  // Status is computed server-side at fetch time; expire rows client-side as the clock ticks.
  const liveStatus = (s: Session): SessionStatus =>
    s.status === 'active' && Date.parse(s.expiresAt) <= now ? 'expired' : s.status;
  const sessions = data.sessions.filter((s) => showInactive || liveStatus(s) === 'active');
  const canIssue = data.templates.length > 0 && data.accounts.length > 0;

  const revoke = async (s: Session): Promise<void> => {
    const labelSuffix = s.label ? ` (${s.label})` : '';
    if (!confirm(`Revoke session key ${s.keyHint}…${labelSuffix}?`)) return;
    setError(null);
    try {
      await api('POST', `/sessions/${s.id}/revoke`);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section>
      <SectionHeader
        title="Session keys"
        description={SESSION_DESCRIPTIONS[viewer.role]}
        action={
          <Button
            disabled={!canIssue}
            title={canIssue ? undefined : 'Connect an account and create a template first'}
            onClick={() => {
              setIssuing(true);
            }}
          >
            + Issue session key
          </Button>
        }
      />
      <div className="mb-4 flex items-center justify-between gap-4">
        <ErrorBanner message={error} />
        <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            className="size-4 accent-indigo-600"
            checked={showInactive}
            onChange={(e) => {
              setShowInactive(e.target.checked);
            }}
          />
          Show expired & revoked
        </label>
      </div>

      {sessions.length === 0 ? (
        <EmptyState title={showInactive ? 'No session keys yet' : 'No active session keys'}>
          {canIssue
            ? 'Issue a key from one of your templates.'
            : 'You need at least one connected account and one template.'}
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-4 py-3">Key</th>
                <th className="px-4 py-3">Template / accounts</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Expires</th>
                <th className="px-4 py-3">Usage</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sessions.map((s) => {
                const status = liveStatus(s);
                return (
                  <tr key={s.id} className={status === 'active' ? '' : 'text-slate-400'}>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs">{s.keyHint}…</div>
                      {s.label && <div className="text-xs text-slate-500">{s.label}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{s.templateName}</div>
                      <div className="text-xs text-slate-500">{accountLabels(s)}</div>
                      {viewer.role === 'admin' && <IssuedBy issuer={s.issuedBy} />}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[status]}>{status}</Badge>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap" title={formatDateTime(s.expiresAt)}>
                      {status === 'revoked' && s.revokedAt
                        ? `revoked ${formatRelative(s.revokedAt, now)}`
                        : formatRelative(s.expiresAt, now)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {s.requestCount} req
                      {s.lastUsedAt && (
                        <div className="text-xs text-slate-500">
                          last {formatRelative(s.lastUsedAt, now)}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {status === 'active' && (
                        <Button variant="danger" size="sm" onClick={() => void revoke(s)}>
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {issuing && (
        <IssueModal
          api={api}
          data={data}
          onClose={() => {
            setIssuing(false);
          }}
          onIssued={async (result) => {
            setIssuing(false);
            setIssued(result);
            await refresh();
          }}
        />
      )}
      {issued && (
        <KeyRevealModal
          issued={issued}
          tools={data.tools}
          onClose={() => {
            setIssued(null);
          }}
        />
      )}
    </section>
  );
}

function IssuedBy({ issuer }: { issuer: SessionIssuer }) {
  if (issuer.kind === 'admin') return null;
  const by = issuer.kind === 'member' ? 'by member' : 'agent run of';
  return (
    <div className="text-xs text-indigo-600">
      {by} {issuer.memberName}
    </div>
  );
}

function IssueModal({
  api,
  data,
  onClose,
  onIssued,
}: Pick<PanelProps, 'api' | 'data'> & {
  onClose: () => void;
  onIssued: (result: { key: string; session: Session }) => Promise<void>;
}) {
  const first = data.templates[0];
  const [templateId, setTemplateId] = useState(first?.id ?? '');
  const template = data.templates.find((t) => t.id === templateId);
  const [accountIds, setAccountIds] = useState(() => defaultAccounts(first, data.accounts));
  const [ttl, setTtl] = useState(first?.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectTemplate = (id: string): void => {
    const tpl = data.templates.find((t) => t.id === id);
    setTemplateId(id);
    setTtl(tpl?.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS);
    setAccountIds(defaultAccounts(tpl, data.accounts));
  };

  const tooLong = template !== undefined && ttl > template.maxTtlSeconds;
  const chosen = template?.grants.map((g) => accountIds[g.tool] ?? '') ?? [];
  const missingAccount = chosen.length === 0 || chosen.includes('');

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ key: string; session: Session }>('POST', '/sessions', {
        templateId,
        accountIds: chosen,
        ttlSeconds: ttl,
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      await onIssued(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title="Issue a session key" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Template">
          <Select
            value={templateId}
            onChange={(e) => {
              selectTemplate(e.target.value);
            }}
          >
            {data.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        {template && (
          <p className="-mt-2 text-xs text-slate-500">{grantsScope(template.grants, data.tools)}</p>
        )}
        {template?.grants.map((g) => (
          <AccountSelect
            key={g.tool}
            label={
              template.grants.length > 1 ? `${toolName(data.tools, g.tool)} account` : 'Account'
            }
            accounts={data.accounts.filter((a) => a.tool === g.tool)}
            value={accountIds[g.tool] ?? ''}
            onChange={(id) => {
              setAccountIds((ids) => ({ ...ids, [g.tool]: id }));
            }}
          />
        ))}
        <Field
          label="Time to live"
          hint={
            template
              ? `Maximum for this template: ${formatDuration(template.maxTtlSeconds)}`
              : undefined
          }
        >
          <DurationInput value={ttl} onChange={setTtl} />
        </Field>
        <Field label="Label (optional)" hint="Who or what will use this key, e.g. “release agent”.">
          <Input
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
            }}
          />
        </Field>
        <ErrorBanner
          message={error ?? (tooLong ? 'TTL exceeds the maximum allowed by this template.' : null)}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || missingAccount || tooLong}>
            {busy ? 'Issuing…' : 'Issue key'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Initial account choice for each tool of a template: the first usable account. */
function defaultAccounts(
  template: TemplateSummary | undefined,
  accounts: Account[],
): Record<string, string> {
  return Object.fromEntries(
    (template?.grants ?? []).map((g) => [
      g.tool,
      accounts.find((a) => a.tool === g.tool)?.id ?? '',
    ]),
  );
}

function AccountSelect({
  label,
  accounts,
  value,
  onChange,
}: {
  label: string;
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Field label={label}>
      <Select
        value={value}
        required
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        {accounts.length === 0 && <option value="">No matching account</option>}
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label} ({a.identity.login ?? a.tool})
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Example `curl` call through the gateway, from the tool's own example. */
function exampleCurl(key: string, base: string, tool: Tool | undefined): string {
  const example = tool?.example;
  if (!example) return `curl -H "Authorization: Bearer ${key}" ${base}/`;
  const lines = [`curl -H "Authorization: Bearer ${key}"`];
  if (example.method !== 'GET') lines.push(`-X ${example.method}`);
  if (example.body !== undefined) {
    lines.push(`-H "Content-Type: application/json"`, `-d '${example.body}'`);
  }
  lines.push(`${base}${example.path}`);
  return lines.join(' \\\n  ');
}

/** Proxy base URL per tool; a single-tool key keeps the plain `GATEWAY_URL` name. */
function envSnippet(key: string, bases: { tool: string; base: string }[]): string {
  const urls = bases.map(({ tool, base }) =>
    bases.length === 1
      ? `export GATEWAY_URL=${base}`
      : `export GATEWAY_${tool.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_URL=${base}`,
  );
  return [...urls, `export GATEWAY_SESSION_KEY=${key}`].join('\n');
}

function KeyRevealModal({
  issued,
  tools,
  onClose,
}: {
  issued: { key: string; session: Session };
  tools: Tool[];
  onClose: () => void;
}) {
  const bases = issued.session.grants.map((g) => ({
    tool: g.tool,
    base: `${window.location.origin}/proxy/${g.tool}`,
  }));

  return (
    <Modal wide open title="Session key issued" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          Copy this key now — it is not stored and will not be shown again.
        </div>
        <div className="flex items-center gap-2">
          <code className="block flex-1 overflow-x-auto rounded-md bg-slate-900 px-3 py-2 font-mono text-sm whitespace-nowrap text-emerald-300">
            {issued.key}
          </code>
          <CopyButton value={issued.key} />
        </div>
        <p className="text-sm text-slate-600">
          Valid until <strong>{formatDateTime(issued.session.expiresAt)}</strong> with template{' '}
          <strong>{issued.session.templateName}</strong>
          {bases.length > 1 && <> on {bases.map((b) => toolName(tools, b.tool)).join(', ')}</>}.
        </p>
        <Snippet title="Environment" value={envSnippet(issued.key, bases)} />
        {bases.map(({ tool: id, base }) => {
          const tool = tools.find((t) => t.id === id);
          return (
            <div key={id} className="space-y-2">
              <Snippet
                title={
                  bases.length > 1 ? `Example request (${tool?.name ?? id})` : 'Example request'
                }
                value={exampleCurl(issued.key, base, tool)}
              />
              <p className="text-xs text-slate-500">
                Use <code className="font-mono">{base}</code> as the {tool?.name ?? id} API base URL
                {tool && ` (${tool.example.clientHint})`}.
              </p>
            </div>
          );
        })}
        <p className="text-xs text-slate-500">
          <code className="font-mono">GET /api/session</code> with the key returns its permissions
          and expiry.
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
