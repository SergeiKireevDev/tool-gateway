'use client';

import { useEffect, useEffectEvent, useState } from 'react';
import type { Api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { MS_PER_SECOND } from '@/lib/units';
import type { DeviceFlowStart, DeviceFlowStatus, Tool } from '@/lib/types';
import { Button, CopyButton, ErrorBanner, Field, Input, useNow } from './ui';

/**
 * Interactive sign-in through the OAuth device flow: the gateway asks the tool for a one-time
 * code, the admin approves it on the tool's website, and the gateway receives the token.
 */
export function DeviceSignIn({
  api,
  tool,
  onConnected,
  onSettingsChanged,
  onCancel,
  canConfigure,
}: {
  api: Api;
  tool: Tool & { signIn: NonNullable<Tool['signIn']> };
  onConnected: () => Promise<void>;
  onSettingsChanged: () => Promise<void>;
  onCancel: () => void;
  /** Whether the viewer may set the OAuth app client ID (admin only). */
  canConfigure: boolean;
}) {
  const [editingClient, setEditingClient] = useState(!tool.signIn.oauthClientId);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState(tool.signIn.defaultScopes);
  const [flow, setFlow] = useState<DeviceFlowStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (editingClient) {
    return (
      <ClientSetup
        api={api}
        tool={tool}
        onSaved={async () => {
          await onSettingsChanged();
          setEditingClient(false);
        }}
        onCancel={
          tool.signIn.oauthClientId
            ? () => {
                setEditingClient(false);
              }
            : onCancel
        }
      />
    );
  }

  if (flow) {
    return (
      <PendingApproval
        api={api}
        flow={flow}
        toolName={tool.name}
        onConnected={onConnected}
        onRestart={(message) => {
          setFlow(null);
          setError(message);
        }}
        onCancel={() => {
          void api('DELETE', `/device-flows/${flow.flowId}`).catch(() => undefined);
          setFlow(null);
        }}
      />
    );
  }

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setFlow(
        await api<DeviceFlowStart>('POST', '/device-flows', { tool: tool.id, label, scopes }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <Field label="Label" hint="A name to recognise this account, e.g. “Personal” or “Work”.">
        <Input
          required
          autoFocus
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
          }}
        />
      </Field>
      <Field
        label="Requested scopes"
        hint={
          <>
            Space-separated OAuth scopes. <code className="font-mono">repo</code> is needed for
            private repositories; templates then narrow down what each session key can do.
          </>
        }
      >
        <Input
          className="font-mono"
          value={scopes}
          onChange={(e) => {
            setScopes(e.target.value);
          }}
        />
      </Field>
      <ErrorBanner message={error} />
      {canConfigure && (
        <p className="text-xs text-slate-500">
          OAuth app <span className="font-mono">{tool.signIn.oauthClientId}</span> ·{' '}
          <button
            type="button"
            className="underline-offset-2 hover:text-slate-800 hover:underline"
            onClick={() => {
              setEditingClient(true);
            }}
          >
            change
          </button>
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !label.trim()}>
          {busy ? `Contacting ${tool.name}…` : `Sign in with ${tool.name}`}
        </Button>
      </div>
    </form>
  );
}

function ClientSetup({
  api,
  tool,
  onSaved,
  onCancel,
}: {
  api: Api;
  tool: Tool & { signIn: NonNullable<Tool['signIn']> };
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [clientId, setClientId] = useState(tool.signIn.oauthClientId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api('PUT', `/tools/${tool.id}/settings`, { oauthClientId: clientId });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-700 ring-1 ring-slate-200">
        <p className="font-medium">One-time setup</p>
        <p className="mt-1 text-slate-600">{tool.signIn.setupHelp}</p>
        <a
          href={tool.signIn.registerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block font-medium text-indigo-600 hover:text-indigo-500"
        >
          Register a new OAuth App on {tool.name} ↗
        </a>
      </div>
      <Field label="OAuth App client ID">
        <Input
          required
          autoFocus
          className="font-mono"
          placeholder="Ov23li…"
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value);
          }}
        />
      </Field>
      <ErrorBanner message={error} />
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !clientId.trim()}>
          {busy ? 'Saving…' : 'Save client ID'}
        </Button>
      </div>
    </form>
  );
}

function PendingApproval({
  api,
  flow,
  toolName,
  onConnected,
  onRestart,
  onCancel,
}: {
  api: Api;
  flow: DeviceFlowStart;
  toolName: string;
  onConnected: () => Promise<void>;
  onRestart: (message: string) => void;
  onCancel: () => void;
}) {
  const now = useNow();
  const handle = useEffectEvent((result: DeviceFlowStatus) => {
    if (result.status === 'complete') void onConnected();
    else if (result.status === 'failed') onRestart(result.message);
  });
  const fail = useEffectEvent((err: unknown) => {
    onRestart((err as Error).message);
  });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      api<DeviceFlowStatus>('POST', `/device-flows/${flow.flowId}/poll`).then(
        (result) => {
          if (stopped) return;
          if (result.status === 'pending')
            timer = setTimeout(tick, flow.intervalSeconds * MS_PER_SECOND);
          else handle(result);
        },
        (err: unknown) => {
          if (!stopped) fail(err);
        },
      );
    };
    timer = setTimeout(tick, flow.intervalSeconds * MS_PER_SECOND);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, flow]);

  return (
    <div className="space-y-5 text-center">
      <p className="text-sm text-slate-600">
        Open {toolName} and enter this code to authorize the gateway:
      </p>
      <div className="flex items-center justify-center gap-3">
        <code className="rounded-lg bg-slate-900 px-5 py-3 font-mono text-2xl font-semibold tracking-[0.3em] text-white">
          {flow.userCode}
        </code>
        <CopyButton value={flow.userCode} />
      </div>
      <a
        href={flow.verificationUri}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Open {flow.verificationUri.replace(/^https?:\/\//, '')} ↗
      </a>
      <p className="flex items-center justify-center gap-2 text-sm text-slate-500">
        <span className="size-2 animate-pulse rounded-full bg-indigo-500" />
        Waiting for approval… code expires {formatRelative(flow.expiresAt, now)}
      </p>
      <div className="flex justify-center">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel sign-in
        </Button>
      </div>
    </div>
  );
}
