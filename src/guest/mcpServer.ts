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
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'gateway', version: '1.0.0' },
            instructions:
              'Third-party tools reached through the local gateway. Every call is checked against this run’s permissions and logged.',
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
