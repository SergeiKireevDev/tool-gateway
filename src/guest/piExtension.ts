import { callGatewayTool, gatewayEnv, loadGatewayTools } from './gatewayTools.js';

/**
 * pi extension: registers the gateway's tools as pi tools (pi has no MCP client). Loaded with
 * `pi -e /opt/launchpad/pi-extension.mjs`; reads GATEWAY_URL and GATEWAY_SESSION_KEY.
 */

interface PiToolResult {
  content: { type: 'text'; text: string }[];
  details: { isError: boolean };
}

interface PiExtensionApi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<PiToolResult>;
  }): void;
}

export default async function gatewayExtension(pi: PiExtensionApi): Promise<void> {
  const env = gatewayEnv();
  for (const tool of await loadGatewayTools(env)) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id, params, signal) {
        const result = await callGatewayTool(tool, params, env, fetch, signal);
        return {
          content: [{ type: 'text', text: result.text }],
          details: { isError: result.isError },
        };
      },
    });
  }
}
