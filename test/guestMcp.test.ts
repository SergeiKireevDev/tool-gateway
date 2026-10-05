import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '../src/guest/mcpServer.js';
import { createApp } from '../src/server/http/app.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
let server: Server;
let url: string;
let key: string;

beforeEach(async () => {
  h = await createHarness();
  server = createApp(h.gateway, h.config, { fetch: h.fetch }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Introspection reports proxy URLs from publicUrl: point it at this server.
  (h.config as { publicUrl: string }).publicUrl = url;
  const acc = await h.gateway.createAccount({ tool: 'github', label: 'gh', secret: 'ghp_x' });
  const llm = await h.gateway.createAccount({ tool: 'anthropic', label: 'c', secret: 'sk-ant-x' });
  const tpl = await h.gateway.createTemplate({
    name: 't',
    grants: [
      { tool: 'github', permissions: ['issues:read'], resources: ['o/r'] },
      { tool: 'anthropic', permissions: ['llm:invoke'], resources: [] },
    ],
    defaultTtlSeconds: 600,
    maxTtlSeconds: 600,
  });
  key = (await h.gateway.issueSession({ templateId: tpl.id, accountIds: [acc.id, llm.id] })).key;
});

afterEach(() => {
  server.close();
});

describe('gateway MCP server', () => {
  it('lists one tool per third-party tool and calls through the gateway', async () => {
    const mcp = new McpServer({ gatewayUrl: url, sessionKey: key });
    const init = await mcp.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(init).toMatchObject({
      result: { protocolVersion: '2025-03-26', serverInfo: { name: 'gateway' } },
    });
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();

    const list = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: { name: string; description: string }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual(['gateway_github']);
    expect(list.result.tools[0]?.description).toContain('Issues');
    expect(list.result.tools[0]?.description).toContain('o/r');

    const ok = await mcp.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'gateway_github',
        arguments: { method: 'GET', path: '/repos/o/r/issues', query: { state: 'open' } },
      },
    });
    expect(ok).toMatchObject({ result: { isError: false } });
    expect(h.upstreamCalls.at(-1)?.url).toBe('https://api.github.com/repos/o/r/issues?state=open');

    const denied = (await mcp.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'gateway_github',
        arguments: { method: 'GET', path: '/repos/o/secret/issues' },
      },
    })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]?.text).toContain('denied by the gateway');

    const bad = await mcp.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'gateway_github', arguments: { method: 'TRACE', path: 'x' } },
    });
    expect(bad).toMatchObject({ result: { isError: true } });
    expect(await mcp.handle({ jsonrpc: '2.0', id: 6, method: 'nope' })).toMatchObject({
      error: { code: -32601 },
    });
  });
});
