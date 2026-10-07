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
import type { IconName } from './icons';
import { ErrorBanner } from './ui';
import { WorkspaceShell } from './WorkspaceShell';

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
  /** Sidebar heading the section is listed under. */
  group: string;
  icon: IconName;
  count?: (data: GatewayData) => number;
  render: (props: PanelProps) => ReactNode;
}

const accountsOf = (data: GatewayData, kind: AccountKind): number =>
  data.accounts.filter((a) => kindOf(data.tools, a.tool) === kind).length;

const activeCount = (data: GatewayData): number =>
  data.sessions.filter((s) => s.status === 'active').length;

const ACCESS = 'Access';
const AUTOMATION = 'Automation';

const ADMIN_TABS: TabDef[] = [
  {
    id: 'accounts',
    group: ACCESS,
    icon: 'tools',
    label: 'Tool accounts',
    count: (d) => accountsOf(d, 'tool'),
    render: (p) => <AccountsPanel {...p} kind="tool" />,
  },
  {
    id: 'models',
    group: ACCESS,
    icon: 'models',
    label: 'Model providers',
    count: (d) => accountsOf(d, 'llm'),
    render: (p) => <AccountsPanel {...p} kind="llm" />,
  },
  {
    id: 'templates',
    group: ACCESS,
    icon: 'templates',
    label: 'Templates',
    count: (d) => d.templates.length,
    render: (p) => <TemplatesPanel {...p} />,
  },
  {
    id: 'sessions',
    group: ACCESS,
    icon: 'key',
    label: 'Session keys',
    count: activeCount,
    render: (p) => <SessionsPanel {...p} />,
  },
  {
    id: 'members',
    group: ACCESS,
    icon: 'members',
    label: 'Members',
    count: (d) => d.members.length,
    render: (p) => <MembersPanel {...p} />,
  },
  {
    id: 'runs',
    group: AUTOMATION,
    icon: 'runs',
    label: 'Agent runs',
    render: (p) => <RunsWorkspace api={p.api} base={ADMIN_API} admin accounts={p.data.accounts} />,
  },
  {
    id: 'launchpad',
    group: AUTOMATION,
    icon: 'launchpad',
    label: 'Launchpad',
    render: (p) => <LaunchpadSettingsPanel api={p.api} />,
  },
  {
    id: 'webhooks',
    group: AUTOMATION,
    icon: 'webhooks',
    label: 'Webhooks',
    render: (p) => <WebhooksPanel {...p} />,
  },
  {
    id: 'activity',
    group: 'Monitoring',
    icon: 'activity',
    label: 'Activity',
    render: (p) => <ActivityPanel api={p.api} />,
  },
];

const MEMBER_TABS: TabDef[] = [
  {
    id: 'agents',
    group: 'Workspace',
    icon: 'runs',
    label: 'Agents',
    render: (p) => (
      <RunsWorkspace api={p.api} base={MEMBER_API} admin={false} accounts={p.data.accounts} />
    ),
  },
  {
    id: 'sessions',
    group: ACCESS,
    icon: 'key',
    label: 'Session keys',
    count: activeCount,
    render: (p) => <SessionsPanel {...p} />,
  },
  {
    id: 'accounts',
    group: ACCESS,
    icon: 'tools',
    label: 'My tools',
    count: (d) => accountsOf(d, 'tool'),
    render: (p) => <AccountsPanel {...p} kind="tool" />,
  },
  {
    id: 'models',
    group: ACCESS,
    icon: 'models',
    label: 'My model providers',
    count: (d) => accountsOf(d, 'llm'),
    render: (p) => <AccountsPanel {...p} kind="llm" />,
  },
  {
    id: 'templates',
    group: ACCESS,
    icon: 'templates',
    label: 'My templates',
    render: (p) => <MyTemplatesPanel {...p} />,
  },
  {
    id: 'webhooks',
    group: AUTOMATION,
    icon: 'webhooks',
    label: 'Webhooks',
    render: (p) => <WebhooksPanel {...p} />,
  },
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

const currentHash = (): string => window.location.hash.slice(1);

/** The selected section, kept in the URL hash so it survives reloads and can be linked to. */
function useSectionHash(): [string, (id: string) => void] {
  const [section, setSection] = useState(currentHash);
  useEffect(() => {
    const onHashChange = () => {
      setSection(currentHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);
  const select = useCallback((id: string) => {
    window.history.pushState(null, '', `#${id}`);
    setSection(id);
  }, []);
  return [section, select];
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
  const [tabId, setTabId] = useSectionHash();
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
  const items = tabs.map(({ id, label, group, icon, count }) => ({
    id,
    label,
    group,
    icon,
    count: data && count ? count(data) : undefined,
  }));

  return (
    <WorkspaceShell
      items={items}
      activeId={tab?.id ?? ''}
      onSelect={setTabId}
      title={title}
      subtitle={subtitle}
      identity={identity}
      onSignOut={onSignOut}
    >
      <ErrorBanner message={error} />
      {data && tab?.render({ api, data, refresh, viewer })}
    </WorkspaceShell>
  );
}
