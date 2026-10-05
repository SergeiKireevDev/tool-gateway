'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Api, ApiError } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
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

type AuthKind = 'url' | 'jwt' | 'bearer';
type Source = 'monday' | 'generic';

interface Webhook {
  id: string;
  name: string;
  source: Source;
  auth: AuthKind;
  ownerMemberId: string | null;
  createdAt: string;
  lastEventAt: string | null;
  accepted: number;
  rejected: number;
}

interface Created {
  webhook: Webhook;
  url: string;
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
  jwt: 'Signed token (JWT, e.g. monday.com app)',
  bearer: 'Bearer secret',
};
const HTTP_NOT_FOUND = 404;
const PAYLOAD_PREVIEW = 160;

function CreateForm({
  api,
  onCreated,
  onCancel,
}: {
  api: Api;
  onCreated: (c: Created) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [source, setSource] = useState<Source>('monday');
  const [auth, setAuth] = useState<AuthKind>('url');
  const [signingSecret, setSigningSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        api<Created>('POST', '/webhooks', {
          name,
          source,
          auth,
          ...(auth === 'jwt' ? { signingSecret } : {}),
        }).then(onCreated, (err: unknown) => {
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
          placeholder="e.g. Dev board status changes"
        />
      </Field>
      <Field label="Sender" hint="monday.com webhooks also get their URL challenge answered.">
        <Select
          value={source}
          onChange={(e) => {
            setSource(e.target.value as Source);
          }}
        >
          <option value="monday">monday.com</option>
          <option value="generic">Other</option>
        </Select>
      </Field>
      <Field
        label="Access control"
        hint="Every webhook has a secret, hard-to-guess address. A signed token or bearer secret also proves who sent it."
      >
        <Select
          value={auth}
          onChange={(e) => {
            setAuth(e.target.value as AuthKind);
          }}
        >
          {(Object.keys(AUTH_LABELS) as AuthKind[]).map((k) => (
            <option key={k} value={k}>
              {AUTH_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      {auth === 'jwt' && (
        <Field
          label="Signing secret"
          hint="monday.com: your app → Basic information → Signing Secret. Stored encrypted."
        >
          <Input
            required
            type="password"
            value={signingSecret}
            onChange={(e) => {
              setSigningSecret(e.target.value);
            }}
          />
        </Field>
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

function Reveal({ created, onClose }: { created: Created; onClose: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Copy it now: the address{created.bearerSecret ? ' and the secret are' : ' is'} shown only
        once. Anyone with the address can reach this webhook
        {created.webhook.auth === 'url' ? ', so keep it private' : ''}.
      </p>
      <Snippet title="Webhook address" value={created.url} />
      {created.bearerSecret && (
        <Snippet title="Bearer secret (Authorization: Bearer …)" value={created.bearerSecret} />
      )}
      {created.webhook.source === 'monday' && (
        <p className="text-xs text-slate-500">
          In monday.com: board → Integrations → Webhooks (or the API’s create_webhook) with this
          address. The gateway answers monday’s challenge automatically.
        </p>
      )}
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

/** Inbound webhooks (e.g. monday.com board events), for the admin or a member. */
export function WebhooksPanel({ api, viewer }: Pick<PanelProps, 'api' | 'viewer'>) {
  const now = useNow();
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<Created | null>(null);
  const [open, setOpen] = useState<string | null>(null);

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
  const act = (p: Promise<unknown>): void => {
    p.then(load, (err: unknown) => {
      setError((err as Error).message);
    });
  };

  return (
    <section>
      <SectionHeader
        title="Webhooks"
        description={`Addresses that receive events from other services (e.g. monday.com board changes). Each has a secret address; a signed token or bearer secret can also be required. Every delivery is logged.${viewer.role === 'admin' ? ' You see every member’s webhooks.' : ''}`}
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
          <Card key={w.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{w.name}</span>
                  <Badge tone="indigo">{w.source === 'monday' ? 'monday.com' : 'other'}</Badge>
                  <Badge>{AUTH_LABELS[w.auth]}</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  {w.accepted} accepted · {w.rejected} rejected
                  {w.lastEventAt && ` · last ${formatRelative(w.lastEventAt, now)}`}
                </p>
              </div>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setOpen(open === w.id ? null : w.id);
                  }}
                >
                  {open === w.id ? 'Hide deliveries' : 'Deliveries'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    if (
                      !confirm(
                        'Give this webhook a new address? The current one stops working at once.',
                      )
                    )
                      return;
                    api<Created>('POST', `/webhooks/${w.id}/rotate`).then(
                      (c) => {
                        setRevealed(c);
                        void load();
                      },
                      (err: unknown) => {
                        setError((err as Error).message);
                      },
                    );
                  }}
                >
                  New address
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    if (confirm(`Delete the webhook "${w.name}"?`))
                      act(api('DELETE', `/webhooks/${w.id}`));
                  }}
                >
                  Delete
                </Button>
              </span>
            </div>
            {open === w.id && <Deliveries api={api} webhook={w} />}
          </Card>
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
          onCancel={() => {
            setCreating(false);
          }}
          onCreated={(c) => {
            setCreating(false);
            setRevealed(c);
            void load();
          }}
        />
      </Modal>
      <Modal
        wide
        open={revealed !== null}
        title="Webhook address"
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
