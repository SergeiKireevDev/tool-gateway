'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Api, ApiError } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { HTTP_NOT_FOUND } from '@/lib/http';
import {
  type ConversationChannel,
  describeChannelDeliveries,
  splitList,
  WEBHOOK_SOURCES,
  type WebhookSource,
} from '@/lib/launchpad';
import type { TemplateSummary } from '@/lib/types';
import { SECONDS_PER_HOUR } from '@/lib/units';
import {
  Button,
  Card,
  DurationInput,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Select,
} from '../ui';
import { type FilterDraft, FilterFields, NO_FILTERS, toDraft, toFilters } from './FilterFields';

const BASE = '/launchpad/channels';
/** Longest key expression the gateway accepts. */
const MAX_KEY_CHARS = 500;
/** What a new agent TTL starts at, when the admin sets one. */
const DEFAULT_AGENT_TTL_HOURS = 8;

interface Draft {
  name: string;
  description: string;
  conversationKey: string;
  /** Comma-separated, as typed. */
  eventTypes: string;
  sources: WebhookSource[];
  filters: FilterDraft;
  /** '' = the trigger's own template. */
  templateId: string;
  /** null: the launchpad's default timeout. */
  agentTtlSeconds: number | null;
}

const EMPTY: Draft = {
  name: '',
  description: '',
  conversationKey: '',
  eventTypes: '',
  sources: [],
  filters: NO_FILTERS,
  templateId: '',
  agentTtlSeconds: null,
};

const toForm = (c: ConversationChannel): Draft => ({
  ...c,
  eventTypes: c.eventTypes.join(', '),
  filters: toDraft(c.filters),
  templateId: c.templateId ?? '',
});

/** The sources of the webhooks a channel carries, like a trigger's webhook; none checked: any. */
function SourcesField({
  sources,
  setSources,
}: {
  sources: WebhookSource[];
  setSources: (v: WebhookSource[]) => void;
}) {
  return (
    <Field label="Webhook sources" hint="The webhooks whose events it carries. None checked: any.">
      <div className="flex flex-wrap gap-4">
        {(Object.keys(WEBHOOK_SOURCES) as WebhookSource[]).map((k) => (
          <label key={k} className="flex items-center gap-1.5 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={sources.includes(k)}
              onChange={(e) => {
                setSources(e.target.checked ? [...sources, k] : sources.filter((s) => s !== k));
              }}
            />
            {WEBHOOK_SOURCES[k]}
          </label>
        ))}
      </div>
    </Field>
  );
}

/** The access template of the channel's agents, and how long each may live. */
function AgentFields({
  templates,
  draft,
  setDraft,
}: {
  templates: TemplateSummary[];
  draft: Draft;
  setDraft: (v: Draft) => void;
}) {
  const ttl = draft.agentTtlSeconds;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field
        label="Agent template"
        hint="The access its agents get: members' triggers on the channel must use it."
      >
        <Select
          value={draft.templateId}
          onChange={(e) => {
            setDraft({ ...draft, templateId: e.target.value });
          }}
        >
          <option value="">The trigger&apos;s own</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Agent TTL"
        hint="How long each of its agents may live, for long sessions (within the template's max TTL)."
      >
        <label className="mb-2 flex items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={ttl !== null}
            onChange={(e) => {
              setDraft({
                ...draft,
                agentTtlSeconds: e.target.checked
                  ? DEFAULT_AGENT_TTL_HOURS * SECONDS_PER_HOUR
                  : null,
              });
            }}
          />
          {ttl === null ? 'The default run timeout' : 'Its own'}
        </label>
        {ttl !== null && (
          <DurationInput
            value={ttl}
            onChange={(v) => {
              setDraft({ ...draft, agentTtlSeconds: v });
            }}
          />
        )}
      </Field>
    </div>
  );
}

/** Adds a channel, or edits one (its conversations stay under the keys they had). */
function ChannelForm({
  api,
  editing,
  templates,
  onSaved,
}: {
  api: Api;
  editing: ConversationChannel | null;
  templates: TemplateSummary[];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(editing ? toForm(editing) : EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (): void => {
    setBusy(true);
    const body = {
      name: draft.name,
      description: draft.description,
      conversationKey: draft.conversationKey,
      eventTypes: splitList(draft.eventTypes),
      sources: draft.sources,
      filters: toFilters(draft.filters),
      templateId: draft.templateId === '' ? null : draft.templateId,
      agentTtlSeconds: draft.agentTtlSeconds,
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
      <SourcesField
        sources={draft.sources}
        setSources={(sources) => {
          setDraft({ ...draft, sources });
        }}
      />
      <FilterFields
        filters={draft.filters}
        setFilters={(filters) => {
          setDraft({ ...draft, filters });
        }}
      />
      <AgentFields templates={templates} draft={draft} setDraft={setDraft} />
      <ErrorBanner message={error} />
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {editing ? 'Save' : 'Add channel'}
        </Button>
      </div>
    </form>
  );
}

/** "agents use triage, live up to 8h", or nothing when the channel sets neither. */
function describeAgents(channel: ConversationChannel, templates: TemplateSummary[]): string {
  const parts = [
    channel.templateId === null
      ? null
      : `agents use ${templates.find((t) => t.id === channel.templateId)?.name ?? 'a deleted template'}`,
    channel.agentTtlSeconds === null
      ? null
      : `live up to ${formatDuration(channel.agentTtlSeconds)}`,
  ].filter(Boolean);
  return parts.length > 0 ? `; ${parts.join(', ')}` : '';
}

function ChannelRow({
  channel,
  templates,
  act,
  onEdit,
}: {
  channel: ConversationChannel;
  templates: TemplateSummary[];
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
          {describeChannelDeliveries(channel)}
          {describeAgents(channel, templates)}
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
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
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
  useEffect(() => {
    api<TemplateSummary[]>('GET', '/templates').then(setTemplates, () => undefined);
  }, [api]);

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
            of the payload. Like a trigger, a channel picks the deliveries it carries (webhook
            sources, event types, filters); it also sets the template of its agents and how long
            they live. Members pick one of those they can pick for their triggers; triggers on a
            channel that is disabled or deleted stop.
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
                templates={templates}
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
            templates={templates}
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
