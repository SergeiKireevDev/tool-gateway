import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { parseRefUpdates } from '../src/server/tools/githubGit.js';
import { createHarness, type Harness } from './helpers.js';

const run = promisify(execFile);
const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** A git pkt-line. */
const pkt = (line: string): string => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
const pushBody = (...updates: string[]): Buffer =>
  Buffer.from(
    updates
      .map((u, i) => pkt(i === 0 ? `${u}\0report-status side-band-64k\n` : `${u}\n`))
      .join('') + '0000PACK…',
  );

describe('parseRefUpdates', () => {
  it('reads the ref updates before the pack', () => {
    expect(
      parseRefUpdates(pushBody(`${A} ${B} refs/heads/feature`, `${ZERO} ${B} refs/heads/new`)),
    ).toEqual([
      { oldId: A, newId: B, ref: 'refs/heads/feature' },
      { oldId: ZERO, newId: B, ref: 'refs/heads/new' },
    ]);
    expect(() => parseRefUpdates(Buffer.from('zzzz'))).toThrow('Malformed');
    expect(() => parseRefUpdates(Buffer.from(pkt('nonsense\n')))).toThrow('Malformed');
  });
});

let h: Harness;
let key: string;

async function issueKey(permissions: string[]): Promise<string> {
  const acc = await h.gateway.createAccount({ tool: 'github', label: 'gh', secret: 'ghp_x' });
  const tpl = await h.gateway.createTemplate({
    name: `t-${permissions.join('-')}`,
    grants: [{ tool: 'github', permissions, resources: ['o/r'] }],
    defaultTtlSeconds: 600,
    maxTtlSeconds: 600,
  });
  return (await h.gateway.issueSession({ templateId: tpl.id, accountIds: [acc.id] })).key;
}

describe('git smart HTTP policy', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    h = await createHarness();
    app = createApp(h.gateway, h.config, { fetch: h.fetch });
    key = await issueKey(['contents:read', 'contents:write']);
  });
  const git = (
    method: 'get' | 'post',
    p: string,
    body?: Buffer,
    extra: Record<string, string> = {},
  ) => {
    const req = request(app)
      [method](`/proxy/github/git/o/r.git${p}`)
      .set('authorization', `Basic ${Buffer.from(`x:${key}`).toString('base64')}`);
    for (const [k, v] of Object.entries(extra)) req.set(k, v);
    return body
      ? req.set('content-type', 'application/x-git-receive-pack-request').send(body)
      : req;
  };

  it('forwards fetches to github.com with the real token as basic auth', async () => {
    await git('get', '/info/refs?service=git-upload-pack').expect(200);
    const call = h.upstreamCalls.at(-1);
    expect(call?.url).toBe('https://github.com/o/r.git/info/refs?service=git-upload-pack');
    const auth = new Headers(call?.init.headers).get('authorization') ?? '';
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe(
      'x-access-token:ghp_x',
    );
  });

  it('lets branches be pushed, never the default branch, deletions or tags', async () => {
    await git('post', '/git-receive-pack', pushBody(`${A} ${B} refs/heads/feature`)).expect(200);
    expect(h.upstreamCalls.at(-1)?.url).toBe('https://github.com/o/r.git/git-receive-pack');
    const main = await git(
      'post',
      '/git-receive-pack',
      pushBody(`${A} ${B} refs/heads/main`),
    ).expect(403);
    expect(main.body.message).toContain('default branch');
    await git('post', '/git-receive-pack', pushBody(`${A} ${ZERO} refs/heads/feature`)).expect(403);
    await git('post', '/git-receive-pack', pushBody(`${ZERO} ${B} refs/tags/v1`)).expect(403);
    await git('post', '/git-receive-pack', gzipSync(pushBody(`${A} ${B} refs/heads/main`)), {
      'content-encoding': 'gzip',
    }).expect(403);
  });

  it('needs contents:write to push, the allowlist, and known git endpoints', async () => {
    key = await issueKey(['contents:read']);
    await git('get', '/info/refs?service=git-receive-pack').expect(403);
    await git('get', '/info/refs?service=git-upload-pack').expect(200);
    await request(app)
      .get('/proxy/github/git/o/other.git/info/refs?service=git-upload-pack')
      .set('authorization', `Bearer ${key}`)
      .expect(403);
    await git('get', '/objects/info/packs').expect(403);
    await git('get', '/info/refs?service=git-upload-pack&x=1').expect(403);
  });

  it('challenges clients that send no credentials', async () => {
    const res = await request(app)
      .get('/proxy/github/git/o/r.git/info/refs?service=git-upload-pack')
      .expect(401);
    expect(res.headers['www-authenticate']).toBe('Basic realm="gateway"');
  });
});

/**
 * Real git through the gateway: "github.com" is `git http-backend` serving a local bare repo.
 */
describe('real git clone and push through the gateway', () => {
  let server: Server;
  let base: string;
  let root: string;

  /** Runs `git http-backend` (CGI) for one request and turns its output into a Response. */
  const httpBackend = (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    return new Promise((resolve, reject) => {
      const cgi = spawn('git', ['http-backend'], {
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH ?? '',
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: init.method ?? 'GET',
          PATH_INFO: u.pathname,
          QUERY_STRING: u.search.slice(1),
          CONTENT_TYPE: headers.get('content-type') ?? '',
          HTTP_CONTENT_ENCODING: headers.get('content-encoding') ?? '',
          GIT_PROTOCOL: headers.get('git-protocol') ?? '',
          REMOTE_USER: 'x-access-token',
        },
      });
      const chunks: Buffer[] = [];
      cgi.stdout.on('data', (c: Buffer) => chunks.push(c));
      cgi.on('error', reject);
      cgi.on('close', () => {
        const out = Buffer.concat(chunks);
        const split = out.indexOf('\r\n\r\n');
        const head = out.subarray(0, split).toString();
        const res = new Headers();
        let status = 200;
        for (const line of head.split('\r\n')) {
          const [name = '', ...rest] = line.split(':');
          if (name.toLowerCase() === 'status') status = Number(rest.join(':').trim().split(' ')[0]);
          else res.set(name, rest.join(':').trim());
        }
        resolve(new Response(out.subarray(split + 4), { status, headers: res }));
      });
      cgi.stdin.end(init.body ? Buffer.from(init.body as Buffer) : undefined);
    });
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'git-upstream-'));
    const work = path.join(root, 'seed');
    await run('git', ['init', '-q', '-b', 'main', work]);
    await writeFile(path.join(work, 'button.css'), '.btn { padding: 4px; }\n');
    await run('git', [
      '-C',
      work,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-qam',
      'init',
      '--allow-empty',
    ]);
    await run('git', ['-C', work, 'add', '.']);
    await run('git', [
      '-C',
      work,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-qm',
      'button',
    ]);
    await run('git', ['clone', '-q', '--bare', work, path.join(root, 'o', 'r.git')]);
    await run('git', ['-C', path.join(root, 'o', 'r.git'), 'config', 'http.receivepack', 'true']);

    h = await createHarness();
    key = await issueKey(['contents:read', 'contents:write']);
    const upstream: typeof fetch = (input, init = {}) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith('https://github.com/') ? httpBackend(url, init) : h.fetch(input, init);
    };
    server = createApp(h.gateway, h.config, { fetch: upstream }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/proxy/github/git/`;
  });
  afterAll(() => {
    server.close();
  });

  const gitAsAgent = (cwd: string, ...args: string[]) =>
    run(
      'git',
      [
        '-c',
        `url.${base}.insteadOf=https://github.com/`,
        '-c',
        `http.${base}.extraHeader=Authorization: Bearer ${key}`,
        '-c',
        'user.name=agent',
        '-c',
        'user.email=a@a',
        ...args,
      ],
      { cwd },
    );

  it('clones, pushes a branch, and is refused on the default branch', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'git-agent-'));
    await gitAsAgent(dir, 'clone', '-q', 'https://github.com/o/r', 'r');
    const repo = path.join(dir, 'r');
    await writeFile(path.join(repo, 'button.css'), '.btn { padding: 6px; }\n');
    await gitAsAgent(repo, 'commit', '-qam', 'Rounder button');
    await gitAsAgent(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/agent/button');
    const { stdout } = await run('git', ['-C', path.join(root, 'o', 'r.git'), 'branch', '--list']);
    expect(stdout).toContain('agent/button');
    await expect(gitAsAgent(repo, 'push', '-q', 'origin', 'HEAD:main')).rejects.toThrow(
      /403|default branch/,
    );
    const calls = h.gateway.activity
      .recent()
      .filter((a) => a.kind === 'proxy')
      .map((a) => `${a.decision ?? ''} ${a.detail}`);
    expect(calls).toEqual(
      expect.arrayContaining([
        'allowed contents:read · git fetch',
        'allowed contents:write · git push agent/button',
      ]),
    );
  }, 30_000);
});
