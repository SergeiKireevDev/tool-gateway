'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  ADMIN_API,
  createApi,
  fetchWebUser,
  MEMBER_API,
  signOutGoogle,
  tokenStore,
  type Api,
  type WebUser,
} from '@/lib/api';
import type {
  Account,
  Member,
  MemberSelf,
  Session,
  Template,
  TemplateSummary,
  Tool,
} from '@/lib/types';
import { type AccountKind, kindOf } from '@/lib/grants';
import { AccountsPanel } from './AccountsPanel';
import { ActivityPanel } from './ActivityPanel';
import { LaunchpadSettingsPanel } from './launchpad/LaunchpadSettingsPanel';
import { RunsWorkspace } from './launchpad/RunsWorkspace';
import { LoginScreen } from './LoginScreen';
import { MyTemplatesPanel } from './MyTemplatesPanel';
import { MembersPanel } from './MembersPanel';
import { SessionsPanel } from './SessionsPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { WebhooksPanel } from './WebhooksPanel';
import { ErrorBanner } from './ui';

export interface GatewayData {
  tools: Tool[];
  accounts: Account[];
  /** Full templates for the admin; only the ones granted (summaries) for a member. */
  templates: TemplateSummary[];
  sessions: Session[];
  members: Member[];
  /** Set in the member portal: the signed-in member. */
  self: MemberSelf | null;
}

/** Who is looking at a screen: screens adapt what they offer (e.g. managing shared accounts). */
export type Viewer = { role: 'admin' } | { role: 'member'; memberId: string; memberName: string };

export interface PanelProps {
  api: Api;
  data: GatewayData;
  refresh: () => Promise<void>;
  viewer: Viewer;
}

interface TabDef {
  id: string;
  label: string;
  count?: (data: GatewayData) => number;
  render: (props: PanelProps) => ReactNode;
}

const accountsOf = (data: GatewayData, kind: AccountKind): number =>
  data.accounts.filter((a) => kindOf(data.tools, a.tool) === kind).length;

const activeCount = (data: GatewayData): number =>
  data.sessions.filter((s) => s.status === 'active').length;

const ADMIN_TABS: TabDef[] = [
  {
    id: 'accounts',
    label: 'Tool accounts',
    count: (d) => accountsOf(d, 'tool'),
    render: (p) => <AccountsPanel {...p} kind="tool" />,
  },
  {
    id: 'models',
    label: 'Model providers',
    count: (d) => accountsOf(d, 'llm'),
    render: (p) => <AccountsPanel {...p} kind="llm" />,
  },
  {
    id: 'templates',
    label: 'Templates',
    count: (d) => d.templates.length,
    render: (p) => <TemplatesPanel {...p} />,
  },
  {
    id: 'sessions',
    label: 'Session keys',
    count: activeCount,
    render: (p) => <SessionsPanel {...p} />,
  },
  {
    id: 'members',
    label: 'Members',
    count: (d) => d.members.length,
    render: (p) => <MembersPanel {...p} />,
  },
  {
    id: 'runs',
    label: 'Agent runs',
    render: (p) => <RunsWorkspace api={p.api} base={ADMIN_API} admin accounts={p.data.accounts} />,
  },
  { id: 'launchpad', label: 'Launchpad', render: (p) => <LaunchpadSettingsPanel api={p.api} /> },
  { id: 'webhooks', label: 'Webhooks', render: (p) => <WebhooksPanel {...p} /> },
  { id: 'activity', label: 'Activity', render: (p) => <ActivityPanel api={p.api} /> },
];

const MEMBER_TABS: TabDef[] = [
  {
    id: 'agents',
    label: 'Agents',
    render: (p) => (
      <RunsWorkspace api={p.api} base={MEMBER_API} admin={false} accounts={p.data.accounts} />
    ),
  },
  {
    id: 'sessions',
    label: 'Session keys',
    count: activeCount,
    render: (p) => <SessionsPanel {...p} />,
  },
  {
    id: 'accounts',
    label: 'My tools',
    count: (d) => accountsOf(d, 'tool'),
    render: (p) => <AccountsPanel {...p} kind="tool" />,
  },
  {
    id: 'models',
    label: 'My model providers',
    count: (d) => accountsOf(d, 'llm'),
    render: (p) => <AccountsPanel {...p} kind="llm" />,
  },
  { id: 'templates', label: 'My templates', render: (p) => <MyTemplatesPanel {...p} /> },
  { id: 'webhooks', label: 'Webhooks', render: (p) => <WebhooksPanel {...p} /> },
];

async function loadAdminData(api: Api): Promise<GatewayData> {
  const [tools, accounts, templates, sessions, members] = await Promise.all([
    api<Tool[]>('GET', '/tools'),
    api<Account[]>('GET', '/accounts'),
    api<Template[]>('GET', '/templates'),
    api<Session[]>('GET', '/sessions'),
    api<Member[]>('GET', '/members'),
  ]);
  return { tools, accounts, templates, sessions, members, self: null };
}

async function loadMemberData(api: Api): Promise<GatewayData> {
  const [tools, accounts, sessions, self] = await Promise.all([
    api<Tool[]>('GET', '/tools'),
    api<Account[]>('GET', '/accounts'),
    api<Session[]>('GET', '/sessions'),
    api<MemberSelf>('GET', '/'),
  ]);
  return { tools, accounts, templates: self.templates, sessions, members: [], self };
}

export function AdminApp() {
  // `undefined` while server-rendering: the token only exists in the browser.
  const token = useSyncExternalStore(tokenStore.subscribe, tokenStore.get, () => undefined);
  // Google session: `undefined` while checking, `null` when not signed in.
  const [webUser, setWebUser] = useState<WebUser | null | undefined>(undefined);

  useEffect(() => {
    if (token !== null) return;
    let active = true;
    fetchWebUser().then(
      (user) => {
        if (active) setWebUser(user);
      },
      () => {
        if (active) setWebUser(null);
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
      setWebUser(null);
    });
  }, []);
  const sessionLost = useCallback(() => {
    tokenStore.clear();
    setWebUser(null);
  }, []);

  if (token === undefined) return null;
  if (token) {
    return (
      <AdminWorkspace
        token={token}
        identity="admin token"
        onSignOut={signOut}
        onUnauthorized={sessionLost}
      />
    );
  }
  if (webUser === undefined) return null;
  if (webUser?.role === 'admin') {
    return (
      <AdminWorkspace
        token={null}
        identity={webUser.email}
        onSignOut={signOut}
        onUnauthorized={sessionLost}
      />
    );
  }
  if (webUser?.role === 'member') {
    return <MemberPortal user={webUser} onSignOut={signOut} onUnauthorized={sessionLost} />;
  }
  return <LoginScreen onTokenLogin={tokenStore.set} />;
}

const ADMIN_VIEWER: Viewer = { role: 'admin' };

function AdminWorkspace({
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
  return (
    <Workspace
      api={api}
      viewer={ADMIN_VIEWER}
      tabs={ADMIN_TABS}
      load={loadAdminData}
      title="Local Gateway"
      subtitle="Scoped, short-lived access to your tools"
      identity={identity}
      onSignOut={onSignOut}
    />
  );
}

function MemberPortal({
  user,
  onSignOut,
  onUnauthorized,
}: {
  user: Extract<WebUser, { role: 'member' }>;
  onSignOut: () => void;
  onUnauthorized: () => void;
}) {
  const api = useMemo(() => createApi(null, onUnauthorized, MEMBER_API), [onUnauthorized]);
  const viewer = useMemo<Viewer>(
    () => ({ role: 'member', memberId: user.memberId, memberName: user.memberName }),
    [user.memberId, user.memberName],
  );
  return (
    <Workspace
      api={api}
      viewer={viewer}
      tabs={MEMBER_TABS}
      load={loadMemberData}
      title={`${user.memberName} · Local Gateway`}
      subtitle="Your agents, accounts and short-lived keys"
      identity={user.email}
      onSignOut={onSignOut}
    />
  );
}

function Workspace({
  api,
  viewer,
  tabs,
  load,
  title,
  subtitle,
  identity,
  onSignOut,
}: {
  api: Api;
  viewer: Viewer;
  tabs: TabDef[];
  load: (api: Api) => Promise<GatewayData>;
  title: string;
  subtitle: string;
  identity: string;
  onSignOut: () => void;
}) {
  const [tabId, setTabId] = useState(tabs[0]?.id ?? '');
  const [data, setData] = useState<GatewayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      load(api).then(
        (d) => {
          setData(d);
          setError(null);
        },
        (err: unknown) => {
          // Surfaced through the banner; callers don't need to handle it.
          setError((err as Error).message);
        },
      ),
    [api, load],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-indigo-600 font-bold text-white">
              G
            </div>
            <div>
              <h1 className="leading-tight font-semibold">{title}</h1>
              <p className="text-xs text-slate-500">{subtitle}</p>
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
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-6" aria-label="Sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTabId(t.id);
              }}
              aria-current={t.id === tab?.id ? 'page' : undefined}
              className={`-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition ${
                t.id === tab?.id
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'
              }`}
            >
              {t.label}
              {data && t.count && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {t.count(data)}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <ErrorBanner message={error} />
        {data && tab?.render({ api, data, refresh, viewer })}
      </main>
    </div>
  );
}
