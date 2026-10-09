'use client';

import { useEffect, useRef, useState } from 'react';
import type { Api } from '@/lib/api';
import { openSignInChannel, stateOf } from '@/lib/signInChannel';
import type { Tool } from '@/lib/types';
import { Button, ErrorBanner, Field, Input } from './ui';

interface Started {
  flowId: string;
  authorizeUrl: string;
  help: string;
}

const POPUP_FEATURES = 'popup,width=520,height=680';

/**
 * "Sign in with …" through OAuth: open the provider's page and approve. When the provider
 * redirects back to the gateway, the callback page hands the address to this dialog; otherwise
 * the user pastes back the address the browser landed on. The gateway keeps the tokens
 * (encrypted) and refreshes them.
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

  const complete = (input: string): Promise<void> =>
    attempt(async () => {
      if (!started) return;
      await api('POST', `/sign-ins/${started.flowId}/complete`, { input });
      await onConnected();
    });

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

  return tool.oauthSignIn?.redirectsBack ? (
    <RedirectSignIn
      tool={tool}
      started={started}
      busy={busy}
      error={error}
      onRedirect={(url) => {
        const failure = new URL(url).searchParams.get('error');
        if (failure) setError(`${tool.name} sign-in did not complete (${failure}): start again`);
        else void complete(url);
      }}
      onPaste={complete}
      onCancel={onCancel}
    />
  ) : (
    <PasteSignIn
      tool={tool}
      started={started}
      busy={busy}
      error={error}
      onPaste={complete}
      onCancel={onCancel}
    />
  );
}

interface StepProps {
  tool: Tool;
  started: Started;
  busy: boolean;
  error: string | null;
  onPaste: (input: string) => Promise<void>;
  onCancel: () => void;
}

/** The provider sends the browser back to the gateway, whose callback page hands us the code. */
function RedirectSignIn({
  tool,
  started,
  busy,
  error,
  onRedirect,
  onPaste,
  onCancel,
}: StepProps & { onRedirect: (url: string) => void }) {
  const [waiting, setWaiting] = useState(false);
  // The latest handler, so the channel isn't reopened on every render.
  const handler = useRef(onRedirect);
  useEffect(() => {
    handler.current = onRedirect;
  });

  useEffect(() => {
    const state = stateOf(started.authorizeUrl);
    const channel = openSignInChannel((message) => {
      if (message.kind !== 'redirect' || state === null || stateOf(message.url) !== state) return;
      channel.post({ kind: 'received', state });
      setWaiting(false);
      handler.current(message.url);
    });
    return () => {
      channel.close();
    };
  }, [started.authorizeUrl]);

  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
        <li>
          <a
            href={started.authorizeUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-indigo-600 hover:underline"
            onClick={(e) => {
              // A popup the callback page can close once it has handed the sign-in back.
              if (window.open(started.authorizeUrl, 'gateway-sign-in', POPUP_FEATURES)) {
                e.preventDefault();
              }
              setWaiting(true);
            }}
          >
            Open the {tool.name} sign-in page
          </a>{' '}
          and approve.
        </li>
        <li>You are sent back here and the account is connected.</li>
      </ol>
      {(waiting || busy) && <p className="text-sm text-slate-500">Waiting for {tool.name}…</p>}
      <ErrorBanner message={error} />
      <Troubleshooting tool={tool} />
      <details className="text-sm text-slate-600">
        <summary className="cursor-pointer">Signing in from another browser?</summary>
        <div className="mt-3">
          <PasteForm
            busy={busy}
            onPaste={onPaste}
            placeholder="https://…/sign-in/callback?code=…"
          />
        </div>
      </details>
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The redirect lands on the user's own machine (a page that doesn't load): paste it back. */
function PasteSignIn({ tool, started, busy, error, onPaste, onCancel }: StepProps) {
  return (
    <div className="space-y-4">
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
      <ErrorBanner message={error} />
      <Troubleshooting tool={tool} />
      <PasteForm
        busy={busy}
        onPaste={onPaste}
        placeholder="http://localhost:53692/callback?code=…"
        onCancel={onCancel}
      />
    </div>
  );
}

/** What to do when the provider refuses the sign-in, from the tool's catalog entry. */
function Troubleshooting({ tool }: { tool: Tool }) {
  const text = tool.oauthSignIn?.troubleshooting;
  if (!text) return null;
  return (
    <details className="text-sm text-slate-600">
      <summary className="cursor-pointer">{tool.name} refuses the sign-in?</summary>
      <p className="mt-2">{text}</p>
    </details>
  );
}

function PasteForm({
  busy,
  onPaste,
  placeholder,
  onCancel,
}: {
  busy: boolean;
  onPaste: (input: string) => Promise<void>;
  placeholder: string;
  onCancel?: () => void;
}) {
  const [pasted, setPasted] = useState('');
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onPaste(pasted);
      }}
    >
      <Field label="Address of the page you landed on">
        <Input
          required
          value={pasted}
          onChange={(e) => {
            setPasted(e.target.value);
          }}
          placeholder={placeholder}
          className="font-mono"
        />
      </Field>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={busy || !pasted.trim()}>
          Connect
        </Button>
      </div>
    </form>
  );
}
