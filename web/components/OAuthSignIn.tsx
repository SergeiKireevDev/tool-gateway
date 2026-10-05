'use client';

import { useState } from 'react';
import type { Api } from '@/lib/api';
import type { Tool } from '@/lib/types';
import { Button, ErrorBanner, Field, Input } from './ui';

interface Started {
  flowId: string;
  authorizeUrl: string;
  help: string;
}

/**
 * "Sign in with …" through OAuth: open the provider's page, approve, then paste back the address
 * the browser landed on. The gateway keeps the tokens (encrypted) and refreshes them.
 */
export function OAuthSignIn({
  api,
  tool,
  onConnected,
  onCancel,
}: {
  api: Api;
  tool: Tool;
  onConnected: () => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(`My ${tool.name}`);
  const [started, setStarted] = useState<Started | null>(null);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attempt = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!started) {
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void attempt(async () => {
            setStarted(await api<Started>('POST', '/sign-ins', { tool: tool.id, label }));
          });
        }}
      >
        <p className="text-sm text-slate-600">{tool.oauthSignIn?.help}</p>
        <Field label="Label">
          <Input
            required
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
            }}
          />
        </Field>
        <ErrorBanner message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Start sign-in
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void attempt(async () => {
          await api('POST', `/sign-ins/${started.flowId}/complete`, { input: pasted });
          await onConnected();
        });
      }}
    >
      <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
        <li>
          <a
            href={started.authorizeUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-indigo-600 hover:underline"
          >
            Open the {tool.name} sign-in page
          </a>{' '}
          and approve.
        </li>
        <li>
          Your browser then shows a page that doesn’t load (on localhost). Copy its full address.
        </li>
        <li>Paste it below.</li>
      </ol>
      <Field label="Address of the page you landed on">
        <Input
          required
          value={pasted}
          onChange={(e) => {
            setPasted(e.target.value);
          }}
          placeholder="http://localhost:53692/callback?code=…"
          className="font-mono"
        />
      </Field>
      <ErrorBanner message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !pasted.trim()}>
          Connect
        </Button>
      </div>
    </form>
  );
}
