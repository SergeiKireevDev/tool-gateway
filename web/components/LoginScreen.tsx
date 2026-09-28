'use client';

import { useEffect, useState } from 'react';
import { createApi, fetchAuthConfig } from '@/lib/api';
import { Button, Card, ErrorBanner, Field, Input } from './ui';

/** Reads and removes `?login_error=` set by the gateway after a failed Google sign-in. */
function takeLoginError(): string | null {
  const url = new URL(window.location.href);
  const error = url.searchParams.get('login_error');
  if (error) {
    url.searchParams.delete('login_error');
    window.history.replaceState(null, '', url);
  }
  return error;
}

export function LoginScreen({ onTokenLogin }: { onTokenLogin: (token: string) => void }) {
  const [google, setGoogle] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(takeLoginError);

  useEffect(() => {
    let active = true;
    fetchAuthConfig().then(
      (config) => {
        if (active) setGoogle(config.google);
      },
      () => {
        if (active) setGoogle(false);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-md p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-indigo-600 text-lg font-bold text-white">
            G
          </div>
          <div>
            <h1 className="text-lg font-semibold">Local Gateway</h1>
            <p className="text-sm text-slate-500">Administrator sign-in</p>
          </div>
        </div>

        <div className="space-y-5">
          <ErrorBanner message={error} />
          {google && (
            <>
              <a
                href="/auth/google/login"
                className="flex w-full items-center justify-center gap-3 rounded-md bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-xs ring-1 ring-slate-300 transition ring-inset hover:bg-slate-50"
              >
                <GoogleLogo />
                Sign in with Google
              </a>
              <details className="group">
                <summary className="cursor-pointer list-none text-center text-xs text-slate-500 hover:text-slate-800">
                  Use the admin token instead
                </summary>
                <div className="mt-4">
                  <TokenForm onLogin={onTokenLogin} onError={setError} />
                </div>
              </details>
            </>
          )}
          {google === false && (
            <>
              <TokenForm onLogin={onTokenLogin} onError={setError} />
              <p className="text-xs text-slate-500">
                Google sign-in is off. Set <code className="font-mono">GOOGLE_CLIENT_ID</code>,{' '}
                <code className="font-mono">GOOGLE_CLIENT_SECRET</code> and{' '}
                <code className="font-mono">GATEWAY_ADMIN_EMAILS</code> in{' '}
                <code className="font-mono">.env</code> to enable it.
              </p>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

function TokenForm({
  onLogin,
  onError,
}: {
  onLogin: (token: string) => void;
  onError: (message: string | null) => void;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      await createApi(token.trim(), () => undefined)('GET', '/status');
      onLogin(token.trim());
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field
        label="Admin token"
        hint={
          <>
            Printed in the gateway console on first start. Lost it? Stop the gateway and run{' '}
            <code className="font-mono">npm run admin:reset-token</code>.
          </>
        }
      >
        <Input
          type="password"
          autoComplete="current-password"
          placeholder="gwa_…"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
          }}
        />
      </Field>
      <Button type="submit" className="w-full" disabled={busy || !token.trim()}>
        {busy ? 'Checking…' : 'Sign in with token'}
      </Button>
    </form>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}
