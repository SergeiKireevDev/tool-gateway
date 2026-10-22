'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { Conversation, ConversationMessage, Trigger } from '@/lib/launchpad';
import { Badge, Button, EmptyState, ErrorBanner, Modal } from '../ui';

const MESSAGE_PREVIEW_CHARS = 2000;

const preview = (text: string): string =>
  text.length > MESSAGE_PREVIEW_CHARS ? `${text.slice(0, MESSAGE_PREVIEW_CHARS)}…` : text;

/** A conversation's messages: the webhook events and what its agents said. */
function Messages({ api, base }: { api: Api; base: string }) {
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<ConversationMessage[]>('GET', `${base}/messages`).then(setMessages, (err: unknown) => {
      setError((err as Error).message);
    });
  }, [api, base]);
  if (error) return <ErrorBanner message={error} />;
  if (!messages) return <p className="text-xs text-slate-500">Loading…</p>;
  return (
    <ol className="mt-2 space-y-2">
      {messages.map((m) => (
        <li
          key={m.id}
          className={m.direction === 'in' ? 'rounded bg-slate-50 p-2' : 'rounded bg-indigo-50 p-2'}
        >
          <div className="text-xs text-slate-500">
            {m.direction === 'in' ? 'Event' : 'Agent'} · {formatDateTime(m.at)}
            {m.runId && ` · run ${m.runId}`}
            {m.direction === 'in' && m.runId === null && ' · waiting'}
          </div>
          <pre className="mt-1 max-h-64 overflow-auto text-xs whitespace-pre-wrap text-slate-700">
            {preview(m.text)}
          </pre>
        </li>
      ))}
    </ol>
  );
}

function ConversationRow({
  api,
  conversation,
  base,
  onForget,
}: {
  api: Api;
  conversation: Conversation;
  base: string;
  onForget: () => void;
}) {
  const [open, setOpen] = useState(false);
  const c = conversation;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm text-slate-800">{c.key}</div>
          <div className="text-xs text-slate-500">
            {c.runs} run(s) · {c.messages} message(s) · active {formatDateTime(c.updatedAt)}
            {c.memory !== null && ' · has memory'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {c.pending > 0 && <Badge tone="amber">{c.pending} waiting</Badge>}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? 'Hide' : 'Messages'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              if (window.confirm(`Forget the conversation "${c.key}"? Its next event starts anew.`))
                onForget();
            }}
          >
            Forget
          </Button>
        </div>
      </div>
      {open && <Messages api={api} base={base} />}
    </li>
  );
}

/** The conversations of a conversation trigger, with their messages. */
export function TriggerConversations({ api, trigger }: { api: Api; trigger: Trigger }) {
  const base = `/launchpad/triggers/${trigger.id}/conversations`;
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failed = (err: unknown): void => {
    setError((err as Error).message);
  };
  const load = useCallback(
    () =>
      api<Conversation[]>('GET', base).then(setConversations, (err: unknown) => {
        setError((err as Error).message);
      }),
    [api, base],
  );
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Keyed by <code className="font-mono">{trigger.conversationKey}</code>. Each conversation
        keeps its messages and the memory its last run left.
      </p>
      {error && <ErrorBanner message={error} />}
      {conversations?.length === 0 && <EmptyState title="No conversation yet" />}
      <ul className="divide-y divide-slate-100">
        {(conversations ?? []).map((c) => (
          <ConversationRow
            key={c.id}
            api={api}
            conversation={c}
            base={`${base}/${c.id}`}
            onForget={() => {
              api('DELETE', `${base}/${c.id}`).then(load, failed);
            }}
          />
        ))}
      </ul>
    </div>
  );
}

/** The conversations of a trigger, in a dialog (closed while `trigger` is null). */
export function ConversationsModal({
  api,
  trigger,
  onClose,
}: {
  api: Api;
  trigger: Trigger | null;
  onClose: () => void;
}) {
  return (
    <Modal
      wide
      open={trigger !== null}
      title={`Conversations of "${trigger?.name ?? ''}"`}
      onClose={onClose}
    >
      {trigger && <TriggerConversations key={trigger.id} api={api} trigger={trigger} />}
    </Modal>
  );
}
