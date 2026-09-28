'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  createApi,
  fetchGoogleAdmin,
  signOutGoogle,
  tokenStore,
  type Api,
  type GoogleAdmin,
} from '@/lib/api';
import type { Account, Member, Session, Template, Tool } from '@/lib/types';
import { AccountsPanel } from './AccountsPanel';
import { ActivityPanel } from './ActivityPanel';
import { LoginScreen } from './LoginScreen';
import { MembersPanel } from './MembersPanel';
import { SessionsPanel } from './SessionsPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { ErrorBanner } from './ui';

export interface GatewayData {
  tools: Tool[];
  accounts: Account[];
  templates: Template[];
  sessions: Session[];
  members: Member[];
}

export interface PanelProps {
  api: Api;
  data: GatewayData;
  refresh: () => Promise<void>;
}

async function fetchAll(api: Api): Promise<GatewayData> {
  const [tools, accounts, templates, sessions, members] = await Promise.all([
    api<Tool[]>('GET', '/tools'),
    api<Account[]>('GET', '/accounts'),
    api<Template[]>('GET', '/templates'),
    api<Session[]>('GET', '/sessions'),
    api<Member[]>('GET', '/members'),
  ]);
  return { tools, accounts, templates, sessions, members };
}

const TABS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'templates', label: 'Templates' },
  { id: 'sessions', label: 'Session keys' },
  { id: 'members', label: 'Members' },
  { id: 'activity', label: 'Activity' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function AdminApp() {
  // `undefined` while server-rendering: the token only exists in the browser.
  const token = useSyncExternalStore(tokenStore.subscribe, tokenStore.get, () => undefined);
  // Google session: `undefined` while checking, `null` when not signed in.
  const [googleAdmin, setGoogleAdmin] = useState<GoogleAdmin | null | undefined>(undefined);

  useEffect(() => {
    if (token !== null) return;
    let active = true;
    fetchGoogleAdmin().then(
      (admin) => {
        if (active) setGoogleAdmin(admin);
      },
      () => {
        if (active) setGoogleAdmin(null);
      },
    );
    return () => {
      active = false;
    };
  }, [token]);

  const signOut = useCallback(() => {
    if (tokenStore.get()) {
      tokenStore.clear();
      return;
    }
    void signOutGoogle().finally(() => {
      setGoogleAdmin(null);
    });
  }, []);
  const sessionLost = useCallback(() => {
    tokenStore.clear();
    setGoogleAdmin(null);
  }, []);

  if (token === undefined) return null;
  if (token) {
    return (
      <Dashboard
        token={token}
        identity="admin token"
        onSignOut={signOut}
        onUnauthorized={sessionLost}
      />
    );
  }
  if (googleAdmin === undefined) return null;
  if (googleAdmin) {
    return (
      <Dashboard
        token={null}
        identity={googleAdmin.email}
        onSignOut={signOut}
        onUnauthorized={sessionLost}
      />
    );
  }
  return <LoginScreen onTokenLogin={tokenStore.set} />;
}

function Dashboard({
  token,
  identity,
  onSignOut,
  onUnauthorized,
}: {
  token: string | null;
  identity: string;
  onSignOut: () => void;
  onUnauthorized: () => void;
}) {
  const api = useMemo(() => createApi(token, onUnauthorized), [token, onUnauthorized]);
  const [tab, setTab] = useState<TabId>('accounts');
  const [data, setData] = useState<GatewayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      fetchAll(api).then(
        (d) => {
          setData(d);
          setError(null);
        },
        (err: unknown) => {
          // Surfaced through the banner; callers don't need to handle it.
          setError((err as Error).message);
        },
      ),
    [api],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeSessions = data?.sessions.filter((s) => s.status === 'active').length ?? 0;
  const counts: Partial<Record<TabId, number>> = data
    ? {
        accounts: data.accounts.length,
        templates: data.templates.length,
        sessions: activeSessions,
        members: data.members.length,
      }
    : {};

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-indigo-600 font-bold text-white">
              G
            </div>
            <div>
              <h1 className="font-semibold leading-tight">Local Gateway</h1>
              <p className="text-xs text-slate-500">Scoped, short-lived access to your tools</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-slate-500">
              Signed in as <span className="font-medium text-slate-700">{identity}</span>
            </span>
            <button
              type="button"
              onClick={onSignOut}
              className="text-slate-500 hover:text-slate-900"
            >
              Sign out
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 px-6" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id);
              }}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition ${
                tab === t.id
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'
              }`}
            >
              {t.label}
              {counts[t.id] !== undefined && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {counts[t.id]}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <ErrorBanner message={error} />
        {data &&
          (() => {
            const props: PanelProps = { api, data, refresh };
            switch (tab) {
              case 'accounts':
                return <AccountsPanel {...props} />;
              case 'templates':
                return <TemplatesPanel {...props} />;
              case 'sessions':
                return <SessionsPanel {...props} />;
              case 'members':
                return <MembersPanel {...props} />;
              case 'activity':
                return <ActivityPanel api={api} />;
            }
          })()}
      </main>
    </div>
  );
}
