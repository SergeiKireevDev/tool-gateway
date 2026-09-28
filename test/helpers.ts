import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../src/server/activity.js';
import type { GatewayConfig } from '../src/server/config.js';
import { Gateway } from '../src/server/gateway.js';
import { CryptoBox } from '../src/server/store/crypto.js';
import { EncryptedStore } from '../src/server/store/store.js';
import { createGitHubProvider } from '../src/server/tools/github.js';
import { ToolRegistry } from '../src/server/tools/registry.js';

export interface Harness {
  gateway: Gateway;
  config: GatewayConfig;
  clock: { now: Date };
  fetch: typeof fetch;
  upstreamCalls: { url: string; init: RequestInit }[];
}

/** Fake GitHub: /user answers for any token, everything else echoes the request. */
export function fakeGitHubFetch(calls: Harness['upstreamCalls']): typeof fetch {
  return (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const auth = new Headers(init.headers).get('authorization');
    if (auth === 'Bearer bad-token') {
      return Promise.resolve(new Response('{"message":"Bad credentials"}', { status: 401 }));
    }
    if (url === 'https://github.com/login/device/code') {
      return Promise.resolve(
        Response.json({
          device_code: 'dev-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
      );
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      return Promise.resolve(Response.json({ error: 'authorization_pending' }));
    }
    if (url === 'https://api.github.com/user') {
      return Promise.resolve(
        Response.json(
          { login: 'octocat', id: 1, name: 'Mona' },
          { headers: { 'x-oauth-scopes': 'repo, read:org' } },
        ),
      );
    }
    return Promise.resolve(
      Response.json(
        { url, method: init.method ?? 'GET' },
        {
          headers: {
            link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"',
            'set-cookie': 'nope=1',
          },
        },
      ),
    );
  };
}

export async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gateway-test-'));
  const config: GatewayConfig = {
    host: '127.0.0.1',
    port: 0,
    storeFile: path.join(dir, 'data', 'store.enc'),
    keyFile: path.join(dir, 'key', 'master.key'),
    publicUrl: 'http://gateway.test',
    google: null,
  };
  const upstreamCalls: Harness['upstreamCalls'] = [];
  const fetch = fakeGitHubFetch(upstreamCalls);
  const crypto = await CryptoBox.fromKeyFile(config.keyFile);
  const store = await EncryptedStore.open(config.storeFile, crypto);
  const clock = { now: new Date('2026-01-01T00:00:00Z') };
  const gateway = new Gateway(
    store,
    crypto,
    new ToolRegistry([createGitHubProvider(fetch)]),
    new ActivityLog(),
    () => clock.now,
  );
  return { gateway, config, clock, fetch, upstreamCalls };
}
