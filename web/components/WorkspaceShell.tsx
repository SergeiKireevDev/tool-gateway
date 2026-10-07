'use client';

import { useState, type ReactNode } from 'react';
import { BrandMark, Icon, type IconName } from './icons';

export interface NavItem {
  id: string;
  label: string;
  group: string;
  icon: IconName;
  /** Shown as a pill next to the label once data has loaded. */
  count?: number;
}

interface ShellProps {
  items: NavItem[];
  activeId: string;
  onSelect: (id: string) => void;
  title: string;
  subtitle: string;
  identity: string;
  onSignOut: () => void;
  children: ReactNode;
}

/** Items bucketed by group, groups in order of first appearance. */
function groupItems(items: NavItem[]): { group: string; items: NavItem[] }[] {
  const groups = new Map<string, NavItem[]>();
  for (const item of items) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  return [...groups].map(([group, grouped]) => ({ group, items: grouped }));
}

function NavLink({
  item,
  active,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const iconTone = active ? 'text-brand-300' : 'text-slate-500 group-hover:text-slate-300';
  return (
    <a
      href={`#${item.id}`}
      onClick={(e) => {
        e.preventDefault();
        onSelect(item.id);
      }}
      aria-current={active ? 'page' : undefined}
      className={`group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition ${
        active
          ? 'bg-white/10 text-white shadow-inner shadow-white/5'
          : 'text-slate-400 hover:bg-white/5 hover:text-white'
      }`}
    >
      {active && (
        <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand-400" aria-hidden />
      )}
      <Icon name={item.icon} className={`size-5 shrink-0 ${iconTone}`} />
      <span className="truncate">{item.label}</span>
      {item.count !== undefined && (
        <span className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-xs text-slate-300 tabular-nums">
          {item.count}
        </span>
      )}
    </a>
  );
}

function SidebarContent({
  items,
  activeId,
  onSelect,
  title,
  subtitle,
  identity,
  onSignOut,
}: Omit<ShellProps, 'children'>) {
  return (
    <div className="flex h-full w-72 flex-col bg-slate-950 ring-1 ring-white/5">
      <div className="flex items-center gap-3 border-b border-white/5 px-5 py-5">
        <BrandMark />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight text-white">{title}</p>
          <p className="truncate text-xs text-slate-400">{subtitle}</p>
        </div>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5" aria-label="Sections">
        {groupItems(items).map(({ group, items: grouped }) => (
          <div key={group}>
            <p className="px-3 pb-2 text-[0.6875rem] font-semibold tracking-wider text-slate-500 uppercase">
              {group}
            </p>
            <ul className="space-y-0.5">
              {grouped.map((item) => (
                <li key={item.id}>
                  <NavLink item={item} active={item.id === activeId} onSelect={onSelect} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="flex items-center gap-3 border-t border-white/5 px-5 py-4">
        <div className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-800 text-xs font-semibold text-slate-200 uppercase ring-1 ring-white/10">
          {identity.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-slate-500">Signed in as</p>
          <p className="truncate text-sm font-medium text-slate-200" title={identity}>{identity}</p>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
          className="rounded-md p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white"
        >
          <Icon name="signOut" />
        </button>
      </div>
    </div>
  );
}

/** Application frame: a sectioned sidebar (a drawer on small screens) next to the content. */
export function WorkspaceShell(props: ShellProps) {
  const { items, activeId, onSelect, children } = props;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const active = items.find((i) => i.id === activeId);

  const select = (id: string) => {
    setDrawerOpen(false);
    onSelect(id);
  };

  return (
    <div className="min-h-screen lg:pl-72">
      <aside className="fixed inset-y-0 left-0 z-30 hidden lg:flex">
        <SidebarContent {...props} onSelect={select} />
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
            onClick={() => {
              setDrawerOpen(false);
            }}
          />
          <div className="relative flex">
            <SidebarContent {...props} onSelect={select} />
          </div>
        </div>
      )}

      <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur sm:px-6 lg:px-10">
        <button
          type="button"
          aria-label="Open navigation"
          className="-ml-1 rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 lg:hidden"
          onClick={() => {
            setDrawerOpen(true);
          }}
        >
          <Icon name="menu" />
        </button>
        {active && (
          <p className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">{active.group}</span>
            <span className="text-slate-300" aria-hidden>/</span>
            <span className="font-medium text-slate-900">{active.label}</span>
          </p>
        )}
      </div>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-10">{children}</main>
    </div>
  );
}
