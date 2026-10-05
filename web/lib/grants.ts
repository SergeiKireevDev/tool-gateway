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

/** Tool accounts (GitHub, Slack…) vs model provider accounts (Anthropic, OpenAI, Gemini). */
export type AccountKind = Tool['kind'];

export function kindOf(tools: readonly Tool[], toolId: string): AccountKind {
  return tools.find((t) => t.id === toolId)?.kind ?? 'tool';
}

export function toolsOfKind(tools: readonly Tool[], kind: AccountKind): Tool[] {
  return tools.filter((t) => t.kind === kind);
}

/** Splits a template's grants into tool access and model access, in that order. */
export function splitGrants<G extends { tool: string }>(
  grants: readonly G[],
  tools: readonly Tool[],
): { tools: G[]; models: G[] } {
  return {
    tools: grants.filter((g) => kindOf(tools, g.tool) === 'tool'),
    models: grants.filter((g) => kindOf(tools, g.tool) === 'llm'),
  };
}
