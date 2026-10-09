'use client';

import { useEffect, useState } from 'react';
import { openSignInChannel, stateOf } from '@/lib/signInChannel';
import { MS_PER_SECOND } from '@/lib/units';
import { Card, CopyButton } from './ui';

/** How long the dialog that started the sign-in has to claim the redirect. */
const CLAIM_TIMEOUT_SECONDS = 3;
const CLAIM_TIMEOUT_MS = CLAIM_TIMEOUT_SECONDS * MS_PER_SECOND;

type Status = { kind: 'waiting' } | { kind: 'claimed' } | { kind: 'unclaimed'; url: string };

/**
 * Where Google sends the browser back after "Sign in with Google" on an account: hands the address
 * to the "Connect account" dialog in the gateway tab, which completes the sign-in.
 */
export function SignInCallback() {
  const [status, setStatus] = useState<Status>({ kind: 'waiting' });

  useEffect(() => {
    const url = window.location.href;
    const state = stateOf(url);
    const timer = setTimeout(() => {
      setStatus({ kind: 'unclaimed', url });
    }, CLAIM_TIMEOUT_MS);
    const channel = openSignInChannel((message) => {
      if (message.kind !== 'received' || message.state !== state) return;
      clearTimeout(timer);
      setStatus({ kind: 'claimed' });
      // Only closes windows the dialog opened; otherwise the message says to close it.
      window.close();
    });
    channel.post({ kind: 'redirect', url });
    return () => {
      clearTimeout(timer);
      channel.close();
    };
  }, []);

  return (
    <main className="mx-auto max-w-lg px-4 py-16">
      <Card className="space-y-3 p-6 text-sm text-slate-700">
        <h1 className="text-base font-semibold text-slate-900">Sign in</h1>
        {status.kind === 'waiting' && <p>Handing the sign-in back to the gateway…</p>}
        {status.kind === 'claimed' && (
          <p>Done: the account is being connected in the gateway tab. You can close this window.</p>
        )}
        {status.kind === 'unclaimed' && (
          <>
            <p>
              No open “Connect account” dialog picked up this sign-in. If it is open in another
              browser, paste this address into it:
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-slate-100 px-2 py-1 font-mono text-xs">
                {status.url}
              </code>
              <CopyButton value={status.url} />
            </div>
          </>
        )}
      </Card>
    </main>
  );
}
