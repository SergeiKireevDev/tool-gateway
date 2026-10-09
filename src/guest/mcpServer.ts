import { createInterface } from 'node:readline';
import {
  callGatewayTool,
  type GatewayEnv,
  type GatewayTool,
  gatewayEnv,
  loadGatewayTools,
} from './gatewayTools.js';

/**
 * Minimal MCP server (stdio, newline-delimited JSON-RPC 2.0) exposing the gateway's tools to MCP
 * harnesses (Claude Code, Codex, Gemini CLI). Started by the harness with GATEWAY_URL and
 * GATEWAY_SESSION_KEY in its environment.
 */

const PROTOCOL_VERSION = '2025-06-18';
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

const INSTRUCTIONS =
  'Third-party tools reached through the local gateway. Every call is checked against this run’s permissions and logged. Each gateway_<tool> tool is a generic HTTP client for that service’s API: call it with method, path (relative to the API root, starting with /), and optionally query and body. The gateway://tools resource describes every tool.';

const GUIDE_URI = 'gateway://tools';
const GUIDE_NAME = 'Gateway tools';
const MARKDOWN = 'text/markdown';

/** The guide resource: weaker models look for how to use a server in its resources first. */
function guide(tools: GatewayTool[]): string {
  const sections = tools.map((t) => `## ${t.name}\n\n${t.description}`);
  return [
    `# ${GUIDE_NAME}`,
    INSTRUCTIONS,
    'Example call arguments: {"method": "GET", "path": "/user"}',
    ...(sections.length > 0 ? sections : ['This run has no third-party tool access.']),
  ].join('\n\n');
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type Reply = { result: unknown } | { error: { code: number; message: string } };

export class McpServer {
  private tools: Promise<GatewayTool[]> | null = null;

  constructor(
    private readonly env: GatewayEnv,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private loadTools(): Promise<GatewayTool[]> {
    this.tools ??= loadGatewayTools(this.env, this.fetchImpl).catch((err: unknown) => {
      this.tools = null;
      throw err;
    });
    return this.tools;
  }

  /** Handles one request; notifications (no id) get no reply. */
  async handle(message: JsonRpcRequest): Promise<Record<string, unknown> | null> {
    if (message.id === undefined || message.id === null) return null;
    let reply: Reply;
    try {
      reply = await this.dispatch(message);
    } catch (err) {
      reply = { error: { code: ERR_INTERNAL, message: (err as Error).message } };
    }
    return { jsonrpc: '2.0', id: message.id, ...reply };
  }

  private async dispatch(message: JsonRpcRequest): Promise<Reply> {
    const params = message.params ?? {};
    switch (message.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion:
              typeof params.protocolVersion === 'string'
                ? params.protocolVersion
                : PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false },
              prompts: { listChanged: false },
            },
            serverInfo: { name: 'gateway', version: '1.0.0' },
            instructions: INSTRUCTIONS,
          },
        };
      case 'ping':
        return { result: {} };
      case 'tools/list': {
        const tools = await this.loadTools();
        return {
          result: {
            tools: tools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          },
        };
      }
      case 'resources/list':
        return {
          result: {
            resources: [
              {
                uri: GUIDE_URI,
                name: GUIDE_NAME,
                description: 'How to call the gateway tools, and what each may do',
                mimeType: MARKDOWN,
              },
            ],
          },
        };
      case 'resources/templates/list':
        return { result: { resourceTemplates: [] } };
      case 'resources/read':
        if (params.uri !== GUIDE_URI)
          return {
            error: { code: ERR_INVALID_PARAMS, message: `Unknown resource ${String(params.uri)}` },
          };
        return {
          result: {
            contents: [{ uri: GUIDE_URI, mimeType: MARKDOWN, text: guide(await this.loadTools()) }],
          },
        };
      case 'prompts/list':
        return { result: { prompts: [] } };
      case 'tools/call': {
        const tools = await this.loadTools();
        const tool = tools.find((t) => t.name === params.name);
        if (!tool)
          return {
            error: { code: ERR_INVALID_PARAMS, message: `Unknown tool ${String(params.name)}` },
          };
        const result = await callGatewayTool(
          tool,
          params.arguments ?? {},
          this.env,
          this.fetchImpl,
        );
        return {
          result: { content: [{ type: 'text', text: result.text }], isError: result.isError },
        };
      }
      default:
        return {
          error: { code: ERR_METHOD_NOT_FOUND, message: `Method not found: ${message.method}` },
        };
    }
  }
}

/** Serves MCP on stdin/stdout until stdin closes. */
export function serveStdio(server: McpServer): void {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return;
    }
    void server.handle(message).then((reply) => {
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
  });
}

if (process.argv[1]?.endsWith('mcp.js')) {
  serveStdio(new McpServer(gatewayEnv()));
}
