'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Api, ApiError } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { WEBHOOK_SOURCES, type WebhookSource } from '@/lib/launchpad';
import type { PanelProps } from './AdminApp';
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
  Snippet,
  useNow,
} from './ui';

type AuthKind = 'url' | 'jwt' | 'bearer' | 'hmac';
type Source = WebhookSource;

interface Webhook {
  id: string;
  name: string;
  source: Source;
  auth: AuthKind;
  ownerMemberId: string | null;
  /** The admin's webhooks only: every member's triggers can listen to it. */
  shared: boolean;
  createdAt: string;
  lastEventAt: string | null;
  accepted: number;
  rejected: number;
}

interface Created {
  webhook: Webhook;
  url?: string;
  bearerSecret?: string;
}

interface Delivery {
  id: number;
  at: string;
  accepted: boolean;
  reason: string | null;
  eventType: string | null;
  payload: unknown;
}

const AUTH_LABELS: Record<AuthKind, string> = {
  url: 'Secret address only',
  hmac: 'Signed body (HMAC-SHA256)',
  jwt: 'Signed token (JWT, e.g. monday.com app)',
  bearer: 'Bearer secret',
};

const SOURCES = WEBHOOK_SOURCES;

/** Senders whose body signature the gateway knows how to check. */
const SIGNS_BODY: readonly Source[] = ['linear', 'github'];

const SECRET_HINTS: Record<'jwt' | 'hmac', string> = {
  jwt: 'monday.com: your app → Basic information → Signing Secret. Stored encrypted.',
  hmac: 'Linear shows it after you create the webhook there (set it here afterwards with “Access control”). GitHub: the webhook’s Secret. Stored encrypted.',
};

const SETUP: Partial<Record<Source, string>> = {
  monday:
    'In monday.com: board → Integrations → Webhooks (or the API’s create_webhook) with this address. The gateway answers monday’s challenge automatically.',
  linear:
    'In Linear: Settings → API → Webhooks → New webhook, with this address. Then copy the signing secret Linear shows and set it here with “Access control” → Signed body.',
  github:
    'In GitHub: repository → Settings → Webhooks → Add webhook, with this address, content type application/json, and the same secret as here.',
};

const SHARE_HINT =
  'Share with every member: their agent triggers can listen to it (only you manage it and see its deliveries)';

const HTTP_NOT_FOUND = 404;
const PAYLOAD_PREVIEW = 160;

const authOptions = (source: Source): AuthKind[] =>
  (Object.keys(AUTH_LABELS) as AuthKind[]).filter(
    (k) => k !== 'hmac' || SIGNS_BODY.includes(source),
  );
const needsSecret = (auth: AuthKind): auth is 'jwt' | 'hmac' => auth === 'jwt' || auth === 'hmac';

/** Access control picker + signing secret, shared by creating and changing a webhook. */
function AuthFields({
  source,
  auth,
  setAuth,
  secret,
  setSecret,
}: {
  source: Source;
  auth: AuthKind;
  setAuth: (a: AuthKind) => void;
  secret: string;
  setSecret: (s: string) => void;
}) {
  return (
    <>
      <Field
        label="Access control"
        hint="Every webhook has a secret, hard-to-guess address. A signature, signed token or bearer secret also proves who sent it."
      >
        <Select
          value={auth}
          onChange={(e) => {
            setAuth(e.target.value as AuthKind);
          }}
        >
          {authOptions(source).map((k) => (
            <option key={k} value={k}>
              {AUTH_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      {needsSecret(auth) && (
        <Field label="Signing secret" hint={SECRET_HINTS[auth]}>
          <Input
            required
            type="password"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
            }}
          />
        </Field>
      )}
    </>
  );
}

function CreateForm({
  api,
  admin,
  onCreated,
  onCancel,
}: {
  api: Api;
  /** The admin can share the webhook with every member. */
  admin: boolean;
  onCreated: (c: Created) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [source, setSource] = useState<Source>('monday');
  const [auth, setAuth] = useState<AuthKind>('url');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const body = {
          name,
          source,
          auth,
          ...(needsSecret(auth) ? { signingSecret: secret } : {}),
          ...(admin ? { shared } : {}),
        };
        api<Created>('POST', '/webhooks', body).then(onCreated, (err: unknown) => {
          setError((err as Error).message);
        });
      }}
    >
      <Field label="Name">
        <Input
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          placeholder="e.g. ENG issue changes"
        />
      </Field>
      <Field
        label="Sender"
        hint="monday.com webhooks get their URL challenge answered; Linear and GitHub ones can check the body signature."
      >
        <Select
          value={source}
          onChange={(e) => {
            const next = e.target.value as Source;
            setSource(next);
            setAuth(next === 'github' ? 'hmac' : 'url');
          }}
        >
          {(Object.keys(SOURCES) as Source[]).map((k) => (
            <option key={k} value={k}>
              {SOURCES[k]}
            </option>
          ))}
        </Select>
      </Field>
      <AuthFields
        source={source}
        auth={auth}
        setAuth={setAuth}
        secret={secret}
        setSecret={setSecret}
      />
      {admin && (
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => {
              setShared(e.target.checked);
            }}
          />
          {SHARE_HINT}
        </label>
      )}
      <ErrorBanner message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Create webhook</Button>
      </div>
    </form>
  );
}

function AuthForm({
  api,
  webhook,
  onSaved,
  onCancel,
}: {
  api: Api;
  webhook: Webhook;
  onSaved: (c: Created) => void;
  onCancel: () => void;
}) {
  const [auth, setAuth] = useState<AuthKind>(
    SIGNS_BODY.includes(webhook.source) ? 'hmac' : webhook.auth,
  );
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        api<Created>('PUT', `/webhooks/${webhook.id}/auth`, {
          auth,
          ...(needsSecret(auth) ? { signingSecret: secret } : {}),
        }).then(onSaved, (err: unknown) => {
          setError((err as Error).message);
        });
      }}
    >
      <p className="text-sm text-slate-600">
        Currently: <strong>{AUTH_LABELS[webhook.auth]}</strong>. The address stays the same.
      </p>
      <AuthFields
        source={webhook.source}
        auth={auth}
        setAuth={setAuth}
        secret={secret}
        setSecret={setSecret}
      />
      <ErrorBanner message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}

function Reveal({ created, onClose }: { created: Created; onClose: () => void }) {
  const setup = SETUP[created.webhook.source];
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Copy it now: {created.url ? 'the address' : 'the secret'}
        {created.url && created.bearerSecret ? ' and the secret are' : ' is'} shown only once.
        {created.url && ' Anyone with the address can reach this webhook, so keep it private.'}
      </p>
      {created.url && <Snippet title="Webhook address" value={created.url} />}
      {created.bearerSecret && (
        <Snippet title="Bearer secret (Authorization: Bearer …)" value={created.bearerSecret} />
      )}
      {created.url && setup && <p className="text-xs text-slate-500">{setup}</p>}
      <div className="flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

function Deliveries({ api, webhook }: { api: Api; webhook: Webhook }) {
  const [events, setEvents] = useState<Delivery[] | null>(null);
  useEffect(() => {
    api<Delivery[]>('GET', `/webhooks/${webhook.id}/events`).then(setEvents, () => {
      setEvents([]);
    });
  }, [api, webhook.id]);
  if (!events) return null;
  if (events.length === 0) return <p className="mt-3 text-sm text-slate-500">No deliveries yet.</p>;
  return (
    <table className="mt-3 min-w-full divide-y divide-slate-100 text-xs">
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <td className="py-1.5 pr-3 whitespace-nowrap text-slate-500">{formatDateTime(e.at)}</td>
            <td className="py-1.5 pr-3">
              <Badge tone={e.accepted ? 'green' : 'red'}>
                {e.accepted ? '✓ accepted' : '✕ rejected'}
              </Badge>
            </td>
            <td className="py-1.5 font-mono text-slate-600">
              {e.accepted
                ? (e.eventType ?? JSON.stringify(e.payload).slice(0, PAYLOAD_PREVIEW))
                : e.reason}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface CardProps {
  api: Api;
  webhook: Webhook;
  /** Whether the viewer is the admin (members can't manage the admin's shared webhooks). */
  admin: boolean;
  now: number;
  onReveal: (c: Created) => void;
  onAuth: (w: Webhook) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

/** Sharing one of the admin's webhooks with every member, or no longer. */
function ShareButton({
  api,
  webhook: w,
  onChanged,
  fail,
}: Pick<CardProps, 'api' | 'webhook' | 'onChanged'> & { fail: (err: unknown) => void }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        if (
          w.shared &&
          !confirm(`Stop sharing "${w.name}"? Members' triggers on it stop at its next delivery.`)
        )
          return;
        api('PATCH', `/webhooks/${w.id}`, { shared: !w.shared }).then(onChanged, fail);
      }}
    >
      {w.shared ? 'Stop sharing' : 'Share'}
    </Button>
  );
}

/** Managing a webhook: its log, access control, address, sharing; deleting it. */
function WebhookActions({
  api,
  webhook: w,
  admin,
  open,
  setOpen,
  onReveal,
  onAuth,
  onChanged,
  onError,
}: Omit<CardProps, 'now'> & { open: boolean; setOpen: (open: boolean) => void }) {
  const fail = (err: unknown): void => {
    onError((err as Error).message);
  };
  return (
    <span className="flex gap-2">
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setOpen(!open);
        }}
      >
        {open ? 'Hide deliveries' : 'Deliveries'}
      </Button>
      {admin && w.ownerMemberId === null && (
        <ShareButton api={api} webhook={w} onChanged={onChanged} fail={fail} />
      )}
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          onAuth(w);
        }}
      >
        Access control
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          if (!confirm('Give this webhook a new address? The current one stops working at once.'))
            return;
          api<Created>('POST', `/webhooks/${w.id}/rotate`).then(onReveal, fail);
        }}
      >
        New address
      </Button>
      <Button
        size="sm"
        variant="danger"
        onClick={() => {
          if (confirm(`Delete the webhook "${w.name}"?`))
            api('DELETE', `/webhooks/${w.id}`).then(onChanged, fail);
        }}
      >
        Delete
      </Button>
    </span>
  );
}

function WebhookCard(props: CardProps) {
  const { webhook: w, admin, now } = props;
  const [open, setOpen] = useState(false);
  // Members only use the admin's shared webhooks.
  const manages = admin || w.ownerMemberId !== null;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{w.name}</span>
            <Badge tone="indigo">{SOURCES[w.source]}</Badge>
            <Badge>{AUTH_LABELS[w.auth]}</Badge>
            {w.shared && (
              <Badge tone="green">
                {admin ? 'Shared with every member' : 'Shared by the admin'}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {w.accepted} accepted · {w.rejected} rejected
            {w.lastEventAt && ` · last ${formatRelative(w.lastEventAt, now)}`}
          </p>
          {!manages && (
            <p className="mt-1 text-xs text-slate-500">
              Your agent triggers can listen to it; the admin manages it.
            </p>
          )}
        </div>
        {manages && <WebhookActions {...props} open={open} setOpen={setOpen} />}
      </div>
      {open && <Deliveries api={props.api} webhook={w} />}
    </Card>
  );
}

/** Inbound webhooks (monday.com, Linear, GitHub…), for the admin or a member. */
export function WebhooksPanel({ api, viewer }: Pick<PanelProps, 'api' | 'viewer'>) {
  const now = useNow();
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Webhook | null>(null);
  const [revealed, setRevealed] = useState<Created | null>(null);

  const load = useCallback(
    () =>
      api<Webhook[]>('GET', '/webhooks').then(setHooks, (err: unknown) => {
        if (err instanceof ApiError && err.status === HTTP_NOT_FOUND) setOff(true);
        else setError((err as Error).message);
      }),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (off) return <EmptyState title="Webhooks are not available on this gateway" />;
  const reveal = (c: Created): void => {
    if (c.url || c.bearerSecret) setRevealed(c);
    void load();
  };

  return (
    <section>
      <SectionHeader
        title="Webhooks"
        description={`Addresses that receive events from other services (monday.com, Linear, GitHub…). Each has a secret address; a body signature, signed token or bearer secret can also be required. Every delivery is logged.${viewer.role === 'admin' ? ' You see every member’s webhooks, and can share yours with every member for their agent triggers.' : ' Webhooks the admin shares are listed too: your agent triggers can listen to them.'}`}
        action={
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            + New webhook
          </Button>
        }
      />
      <div className="mb-4">
        <ErrorBanner message={error} />
      </div>
      {hooks?.length === 0 && <EmptyState title="No webhooks yet" />}
      <div className="space-y-3">
        {hooks?.map((w) => (
          <WebhookCard
            key={w.id}
            api={api}
            webhook={w}
            admin={viewer.role === 'admin'}
            now={now}
            onReveal={reveal}
            onAuth={setEditing}
            onChanged={() => void load()}
            onError={setError}
          />
        ))}
      </div>
      <Modal
        open={creating}
        title="New webhook"
        onClose={() => {
          setCreating(false);
        }}
      >
        <CreateForm
          api={api}
          admin={viewer.role === 'admin'}
          onCancel={() => {
            setCreating(false);
          }}
          onCreated={(c) => {
            setCreating(false);
            reveal(c);
          }}
        />
      </Modal>
      <Modal
        open={editing !== null}
        title={`Access control of “${editing?.name ?? ''}”`}
        onClose={() => {
          setEditing(null);
        }}
      >
        {editing && (
          <AuthForm
            api={api}
            webhook={editing}
            onCancel={() => {
              setEditing(null);
            }}
            onSaved={(c) => {
              setEditing(null);
              reveal(c);
            }}
          />
        )}
      </Modal>
      <Modal
        wide
        open={revealed !== null}
        title="Copy it now"
        onClose={() => {
          setRevealed(null);
        }}
      >
        {revealed && (
          <Reveal
            created={revealed}
            onClose={() => {
              setRevealed(null);
            }}
          />
        )}
      </Modal>
    </section>
  );
}
