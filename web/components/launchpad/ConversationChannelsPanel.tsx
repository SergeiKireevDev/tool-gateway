'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Api, ApiError } from '@/lib/api';
import { HTTP_NOT_FOUND } from '@/lib/http';
import { type ConversationChannel, describeChannelEvents, splitList } from '@/lib/launchpad';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, Modal } from '../ui';

const BASE = '/launchpad/channels';
/** Longest key expression the gateway accepts. */
const MAX_KEY_CHARS = 500;

interface Draft {
  name: string;
  description: string;
  conversationKey: string;
  /** Comma-separated, as typed. */
  eventTypes: string;
}

const EMPTY: Draft = { name: '', description: '', conversationKey: '', eventTypes: '' };

/** Adds a channel, or edits one (its conversations stay under the keys they had). */
function ChannelForm({
  api,
  editing,
  onSaved,
}: {
  api: Api;
  editing: ConversationChannel | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(
    editing ? { ...editing, eventTypes: editing.eventTypes.join(', ') } : EMPTY,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (): void => {
    setBusy(true);
    const body = {
      name: draft.name,
      description: draft.description,
      conversationKey: draft.conversationKey,
      eventTypes: splitList(draft.eventTypes),
    };
    const sent = editing ? api('PUT', `${BASE}/${editing.id}`, body) : api('POST', BASE, body);
    sent.then(onSaved, (err: unknown) => {
      setError((err as Error).message);
      setBusy(false);
    });
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Field label="Name">
        <Input
          required
          value={draft.name}
          placeholder="Linear issue threads"
          onChange={(e) => {
            setDraft({ ...draft, name: e.target.value });
          }}
        />
      </Field>
      <Field label="Description" hint="Shown to members when they pick it.">
        <Input
          value={draft.description}
          placeholder="One conversation per Linear issue"
          onChange={(e) => {
            setDraft({ ...draft, description: e.target.value });
          }}
        />
      </Field>
      <Field
        label="Conversation key"
        hint="A jq-like expression on the webhook payload, e.g. .data.issueId or [.repository.full_name, .issue.number]. Events with the same key go to one long-lived conversation."
      >
        <Input
          required
          value={draft.conversationKey}
          maxLength={MAX_KEY_CHARS}
          placeholder=".data.issueId // .data.id"
          className="font-mono"
          onChange={(e) => {
            setDraft({ ...draft, conversationKey: e.target.value });
          }}
        />
      </Field>
      <Field
        label="Event types"
        hint="The types of notification the channel carries, comma-separated. Comment also matches Comment.create. Empty: every event. Members' triggers can narrow them further."
      >
        <Input
          value={draft.eventTypes}
          placeholder="Comment.create, Issue.update"
          onChange={(e) => {
            setDraft({ ...draft, eventTypes: e.target.value });
          }}
        />
      </Field>
      <ErrorBanner message={error} />
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {editing ? 'Save' : 'Add channel'}
        </Button>
      </div>
    </form>
  );
}

function ChannelRow({
  channel,
  act,
  onEdit,
}: {
  channel: ConversationChannel;
  act: (method: string, path: string, body?: unknown) => void;
  onEdit: () => void;
}) {
  const path = `${BASE}/${channel.id}`;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="font-medium">{channel.name}</div>
        <p className="text-xs text-slate-500">
          {channel.description && `${channel.description} · `}keyed by{' '}
          <code className="font-mono">{channel.conversationKey}</code>, carries{' '}
          {describeChannelEvents(channel.eventTypes)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={channel.enabled}
            onChange={(e) => {
              act('PATCH', path, { enabled: e.target.checked });
            }}
          />
          Members can pick it
        </label>
        <Button variant="secondary" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => {
            if (window.confirm(`Delete the conversation channel "${channel.name}"?`)) {
              act('DELETE', path);
            }
          }}
        >
          Delete
        </Button>
      </div>
    </li>
  );
}

/**
 * Admin: the conversation channels members' webhook triggers can pick. A conversation's agent
 * hears whoever can post to the webhook's source, so only the admin defines them.
 */
export function ConversationChannelsPanel({ api }: { api: Api }) {
  const [channels, setChannels] = useState<ConversationChannel[] | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null: closed; 'new': adding; else the channel edited.
  const [form, setForm] = useState<ConversationChannel | 'new' | null>(null);

  const load = useCallback(
    () =>
      api<ConversationChannel[]>('GET', BASE).then(setChannels, (err: unknown) => {
        if (err instanceof ApiError && err.status === HTTP_NOT_FOUND) setOff(true);
        else setError((err as Error).message);
      }),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const act = (method: string, path: string, body?: unknown): void => {
    api(method, path, body).then(
      () => {
        setError(null);
        void load();
      },
      (err: unknown) => {
        setError((err as Error).message);
      },
    );
  };

  if (off) return null;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Conversation channels</h3>
          <p className="text-xs text-slate-500">
            What makes a webhook trigger a long-lived conversation with its agent, keyed by a value
            of the payload. Members pick one of those they can pick for their triggers; triggers on
            a channel that is disabled or deleted stop.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setForm('new');
          }}
        >
          Add channel
        </Button>
      </div>
      <ErrorBanner message={error} />
      {channels?.length === 0 && (
        <EmptyState title="No conversation channels">
          Webhook triggers launch one agent per event. Add a channel to let them hold conversations.
        </EmptyState>
      )}
      {channels && channels.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-100">
            {channels.map((c) => (
              <ChannelRow
                key={c.id}
                channel={c}
                act={act}
                onEdit={() => {
                  setForm(c);
                }}
              />
            ))}
          </ul>
        </Card>
      )}
      <Modal
        open={form !== null}
        title={form === 'new' || form === null ? 'Add a conversation channel' : `Edit ${form.name}`}
        onClose={() => {
          setForm(null);
        }}
      >
        {form !== null && (
          <ChannelForm
            key={form === 'new' ? 'new' : form.id}
            api={api}
            editing={form === 'new' ? null : form}
            onSaved={() => {
              setForm(null);
              void load();
            }}
          />
        )}
      </Modal>
    </div>
  );
}
