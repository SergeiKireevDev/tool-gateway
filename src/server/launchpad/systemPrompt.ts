import type { Harness } from './protocol.js';

export interface PromptGrant {
  tool: string;
  name: string;
  permissions: { id: string; label: string; description: string }[];
  resources: string[];
  resourceHelp: string;
}

export interface PromptContext {
  harness: Harness;
  /** Tool grants of the run's session key (LLM providers excluded). */
  grants: PromptGrant[];
  deadline: string;
  hasMemory: boolean;
}

/** MCP tool name of a gateway tool, as the runner's MCP server exposes it. */
export const gatewayToolName = (tool: string): string => `gateway_${tool}`;

export const OUT_DIR = '/home/agent/out';
export const MEMORY_FILE = '/home/agent/MEMORY.md';

function describeGrant(g: PromptGrant): string {
  const perms = g.permissions.map((p) => `  - ${p.label} (\`${p.id}\`): ${p.description}`);
  const listed = g.resources.map((r) => '`' + r + '`').join(', ');
  const scope =
    g.resources.length === 0
      ? '  - Not limited to specific resources.'
      : `  - Only these resources: ${listed}.`;
  return [`- **${g.name}** — tool \`${gatewayToolName(g.tool)}\``, ...perms, scope].join('\n');
}

/**
 * The system prompt every launched agent gets: how to reach tools through the gateway, what it is
 * allowed to do, and how its run ends. The task itself is the user prompt.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const tools =
    ctx.grants.length > 0
      ? ctx.grants.map(describeGrant).join('\n')
      : '- None: this run has no third-party tool access.';
  return `You are an autonomous agent launched by the agent launchpad. Nobody watches you work and nobody will answer questions: decide, act, and finish on your own.

## Environment
- You run in a disposable virtual machine as the user \`agent\`, in \`/home/agent/work\`. It is destroyed when you finish.
- The machine has no internet access. The only reachable service is the gateway, which brokers every third-party tool call. Don't try to install packages or reach other hosts.
- Your run ends at ${ctx.deadline}. Finish before then.

## Third-party tools
You reach these only through the gateway MCP tools below. Each call is checked against the permissions granted to this run and logged.
${tools}

If a call is refused with HTTP 403 and an \`x-gateway-denied\` header, the gateway's policy forbids it. Don't retry it or look for a way around it: do what you can within your permissions and explain what you couldn't do.

## Results
- End with a short final message: what you did, what you found, and anything left undone. It is shown to the person who launched you.
- Put files worth keeping (reports, data, patches) in \`${OUT_DIR}\`. They are collected when you finish.
${
  ctx.hasMemory
    ? `- \`${MEMORY_FILE}\` holds notes from your previous runs of this scheduled task. Read it first. Update it with what the next run should know (keep it short); it is carried over.`
    : `- If this task is scheduled to run again, keep notes for your next run in \`${MEMORY_FILE}\` (short). It is carried over.`
}`;
}
