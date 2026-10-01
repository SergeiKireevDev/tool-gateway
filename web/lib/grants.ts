import type { Session, Tool, ToolGrant } from './types';

export function toolName(tools: readonly Tool[], id: string): string {
  return tools.find((t) => t.id === id)?.name ?? id;
}

export function permissionLabel(tools: readonly Tool[], tool: string, id: string): string {
  return tools.find((t) => t.id === tool)?.permissions.find((p) => p.id === id)?.label ?? id;
}

/** "GitHub: o/r · monday.com: all resources" */
export function grantsScope(grants: readonly ToolGrant[], tools: readonly Tool[]): string {
  return grants
    .map((g) => {
      const resources = g.resources.length ? g.resources.join(', ') : 'all resources';
      return `${toolName(tools, g.tool)}: ${resources}`;
    })
    .join(' · ');
}

export function sessionUsesAccount(session: Session, accountId: string): boolean {
  return session.grants.some((g) => g.accountId === accountId);
}
