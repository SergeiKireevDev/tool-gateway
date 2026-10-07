import { once } from 'node:events';
import type { Server } from 'node:http';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proxyEnv } from '../src/guest/runner.js';
import {
  checkDomainPattern,
  domainAllowed,
  isPublicAddress,
} from '../src/server/egress/domains.js';
import { createApp, createVmApp } from '../src/server/http/app.js';
import { attachEgressProxy } from '../src/server/http/egressProxy.js';
import type { RunnerConfig } from '../src/server/launchpad/protocol.js';
import { createHarness, type Harness } from './helpers.js';

describe('domain patterns', () => {
  it('normalizes hosts and subdomain wildcards', () => {
    expect(checkDomainPattern(' Registry.NPMjs.org. ')).toEqual({ pattern: 'registry.npmjs.org' });
    expect(checkDomainPattern('*.pythonhosted.org')).toEqual({ pattern: '*.pythonhosted.org' });
  });

  it.each(['*', '*.com', 'localhost', '10.0.0.1', 'exa mple.com', 'https://pypi.org', '*.*.org'])(
    'refuses %s',
    (input) => {
      expect(checkDomainPattern(input)).toHaveProperty('error');
    },
  );

  it.each(['github.com', 'api.github.com', '*.github.com', '*.openai.com', '*.googleapis.com'])(
    'refuses %s, which the gateway brokers',
    (input) => {
      expect(checkDomainPattern(input)).toMatchObject({
        error: expect.stringContaining('brokers'),
      });
    },
  );

  it('matches exact hosts and subdomains only', () => {
    const patterns = ['pypi.org', '*.pythonhosted.org'];
    expect(domainAllowed('pypi.org', patterns)).toBe(true);
    expect(domainAllowed('files.pythonhosted.org', patterns)).toBe(true);
    expect(domainAllowed('pythonhosted.org', patterns)).toBe(false);
    expect(domainAllowed('evilpythonhosted.org', patterns)).toBe(false);
    expect(domainAllowed('www.pypi.org', patterns)).toBe(false);
  });

  it('tells public addresses from private and local ones', () => {
    for (const ip of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) {
      expect(isPublicAddress(ip)).toBe(true);
    }
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.30.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::ffff:10.0.0.1',
      'fd00::1',
      'fe80::1',
      'not an ip',
    ]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
  });
});

let h: Harness;
let admin: string;
let vmServer: Server;
let upstream: ReturnType<typeof createServer>;
let vmPort: number;

/** Fake DNS: an allowed registry, a name pointing at the host network, and one that fails. */
const DNS: Record<string, string[]> = {
  'registry.npmjs.org': ['104.16.0.1'],
  'files.pythonhosted.org': ['151.101.0.223'],
  'rebind.pythonhosted.org': ['151.101.0.1', '172.30.0.1'],
};

beforeEach(async () => {
  h = await createHarness();
  admin = await h.gateway.rotateAdminToken();
  // Every upstream connection reaches this echo server, whatever address was checked.
  upstream = createServer((socket) => socket.pipe(socket));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const echoPort = (upstream.address() as AddressInfo).port;
  vmServer = createVmApp(h.gateway, { ...h.config, publicUrl: 'http://127.0.0.1:0' }).listen(
    0,
    '127.0.0.1',
  );
  await once(vmServer, 'listening');
  vmPort = (vmServer.address() as AddressInfo).port;
  attachEgressProxy(vmServer, h.gateway, {
    lookup: (host) => {
      const addresses = DNS[host];
      return addresses
        ? Promise.resolve(addresses.map((address) => ({ address })))
        : Promise.reject(new Error('ENOTFOUND'));
    },
    connect: () => connect(echoPort, '127.0.0.1'),
    now: () => h.clock.now.getTime(),
  });
});

afterEach(() => {
  vmServer.closeAllConnections();
  vmServer.close();
  upstream.close();
});

const asAdmin = (method: 'post' | 'put', path: string) =>
  request(createApp(h.gateway, h.config, { fetch: h.fetch }))
    [method](`/api/admin${path}`)
    .set('authorization', `Bearer ${admin}`);

async function sessionKey(egressDomains: string[]): Promise<{ key: string; id: string }> {
  await asAdmin('post', '/accounts')
    .send({ tool: 'github', label: 'gh', secret: 'ghp_x' })
    .expect(201);
  const tpl = await asAdmin('post', '/templates')
    .send({
      name: 'agents',
      grants: [{ tool: 'github', permissions: ['issues:read'], resources: [] }],
      egressDomains,
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 3600,
    })
    .expect(201);
  const res = await asAdmin('post', '/sessions').send({ templateId: tpl.body.id }).expect(201);
  return { key: res.body.key as string, id: res.body.session.id as string };
}

/** Sends a raw request head; resolves with the status line and the still-open socket. */
async function rawRequest(head: string): Promise<{ status: number; socket: Socket; text: string }> {
  const socket = connect(vmPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(head);
  let text = '';
  while (!text.includes('\r\n\r\n')) {
    const [chunk] = (await once(socket, 'data')) as [Buffer];
    text += chunk.toString();
  }
  return { status: Number(text.split(' ')[1]), socket, text };
}

const basic = (key: string): string => Buffer.from(`agent:${key}`).toString('base64');

async function tunnel(target: string, key: string | null) {
  const auth = key ? `Proxy-Authorization: Basic ${basic(key)}\r\n` : '';
  return rawRequest(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
}

describe('egress proxy', () => {
  it('saves normalized domains on the template and snapshots them in keys', async () => {
    const { key } = await sessionKey(['Registry.npmjs.org', '*.pythonhosted.org']);
    const session = h.gateway.resolveSession(key);
    expect(session.egressDomains).toEqual(['registry.npmjs.org', '*.pythonhosted.org']);
    await asAdmin('post', '/templates')
      .send({
        name: 'bad',
        grants: [{ tool: 'github', permissions: ['issues:read'], resources: [] }],
        egressDomains: ['*.github.com'],
        defaultTtlSeconds: 60,
        maxTtlSeconds: 60,
      })
      .expect(400);
  });

  it('tunnels to allowed domains and logs the connection', async () => {
    const { key, id } = await sessionKey(['registry.npmjs.org', '*.pythonhosted.org']);
    const { status, socket } = await tunnel('registry.npmjs.org:443', key);
    expect(status).toBe(200);
    socket.write('hello through the tunnel');
    const [echo] = (await once(socket, 'data')) as [Buffer];
    expect(echo.toString()).toBe('hello through the tunnel');
    socket.end();
    await once(socket, 'close');
    await new Promise((r) => setTimeout(r, 20));
    const [entry] = h.gateway.activity.forSessions([id]).filter((e) => e.tool === 'internet');
    expect(entry).toMatchObject({
      method: 'CONNECT',
      path: 'registry.npmjs.org:443',
      decision: 'allowed',
      status: 200,
    });
    expect(entry?.detail).toContain('24 B sent');
  });

  it('needs a valid session key', async () => {
    const none = await tunnel('registry.npmjs.org:443', null);
    expect(none.status).toBe(407);
    expect(none.text).toContain('Proxy-Authenticate: Basic');
    expect((await tunnel('registry.npmjs.org:443', 'gws_nope')).status).toBe(407);
  });

  it.each([
    ['example.org:443', 403, 'not in this run'],
    ['registry.npmjs.org:80', 403, 'Only HTTPS'],
    ['api.github.com:443', 403, 'brokered'],
    ['rebind.pythonhosted.org:443', 403, 'non-public'],
    ['104.16.0.1:443', 400, 'Expected CONNECT'],
    ['missing.pythonhosted.org:443', 502, 'Could not resolve'],
  ])('refuses %s', async (target, status, message) => {
    const { key, id } = await sessionKey(['registry.npmjs.org', '*.pythonhosted.org']);
    const res = await tunnel(target, key);
    expect(res.status).toBe(status);
    expect(res.text).toContain('x-gateway-denied: true');
    expect(res.text).toContain(message);
    const denied = h.gateway.activity.forSessions([id]).filter((e) => e.decision === 'denied');
    expect(denied).toHaveLength(1);
  });

  it('refuses keys whose template allows no domain', async () => {
    const { key } = await sessionKey([]);
    expect((await tunnel('registry.npmjs.org:443', key)).status).toBe(403);
  });

  it('serves absolute-form requests to itself, and refuses plain HTTP elsewhere', async () => {
    const { key } = await sessionKey(['registry.npmjs.org']);
    const own = await rawRequest(
      `GET http://127.0.0.1:0/api/session HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${key}\r\nConnection: close\r\n\r\n`,
    );
    expect(own.status).toBe(200);
    const other = await rawRequest(
      `GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n`,
    );
    expect(other.status).toBe(403);
  });
});

describe('runner proxy settings', () => {
  const config = (egressDomains: string[]) =>
    ({
      gatewayUrl: 'http://172.30.0.1:7420',
      sessionKey: 'gws_abc',
      egressDomains,
    }) as RunnerConfig;

  it('points the agent at the gateway when the run may reach domains', () => {
    expect(proxyEnv(config([]))).toEqual({});
    expect(proxyEnv(config(['pypi.org']))).toMatchObject({
      HTTPS_PROXY: 'http://agent:gws_abc@172.30.0.1:7420',
      https_proxy: 'http://agent:gws_abc@172.30.0.1:7420',
      NO_PROXY: '172.30.0.1,localhost,127.0.0.1',
    });
  });
});
