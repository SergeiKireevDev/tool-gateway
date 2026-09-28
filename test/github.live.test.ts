/**
 * Tests against the real api.github.com.
 *  - Always: GitHub must reject a bogus credential when connecting an account.
 *  - With GITHUB_TOKEN set: full flow (connect → template → session → proxied calls).
 *    Optionally set GITHUB_TEST_REPO=owner/repo (defaults to the public octocat/Hello-World).
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ActivityLog } from '../src/server/activity.js';
import { Gateway } from '../src/server/gateway.js';
import { createApp } from '../src/server/http/app.js';
import { CryptoBox } from '../src/server/store/crypto.js';
import { EncryptedStore } from '../src/server/store/store.js';
import { createGitHubProvider } from '../src/server/tools/github.js';
import { ToolRegistry } from '../src/server/tools/registry.js';
import { createHarness } from './helpers.js';

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_TEST_REPO ?? 'octocat/Hello-World';

async function liveApp() {
  const { config } = await createHarness();
  const crypto = await CryptoBox.fromKeyFile(config.keyFile);
  const store = await EncryptedStore.open(config.storeFile, crypto);
  const gateway = new Gateway(
    store,
    crypto,
    new ToolRegistry([createGitHubProvider()]),
    new ActivityLog(),
  );
  const admin = await gateway.rotateAdminToken();
  return { app: createApp(gateway, config), admin };
}

describe('real GitHub upstream', { timeout: 30_000 }, () => {
  it('refuses to connect an account with an invalid token', async () => {
    const { app, admin } = await liveApp();
    const res = await request(app)
      .post('/api/admin/accounts')
      .set('authorization', `Bearer ${admin}`)
      .send({ tool: 'github', label: 'bogus', secret: 'ghp_thisIsNotARealToken000000000000000000' })
      .expect(422);
    expect(res.body.message).toMatch(/HTTP 401/);
  });

  it('reports an unknown OAuth client ID when starting sign-in', async () => {
    const { app, admin } = await liveApp();
    const as = (r: request.Test) => r.set('authorization', `Bearer ${admin}`);
    await as(request(app).put('/api/admin/tools/github/settings'))
      .send({ oauthClientId: 'Ov23liNotARealClient00' })
      .expect(200);
    const res = await as(request(app).post('/api/admin/device-flows'))
      .send({ tool: 'github', label: 'x' })
      .expect(502);
    expect(res.body.message).toMatch(/Unknown OAuth client ID/);
  });

  it.skipIf(!token)('proxies scoped requests end to end', async () => {
    const { app, admin } = await liveApp();
    const as = (t: string): [string, string] => ['authorization', `Bearer ${t}`];

    const acc = await request(app)
      .post('/api/admin/accounts')
      .set(...as(admin))
      .send({ tool: 'github', label: 'live', secret: token })
      .expect(201);
    const tpl = await request(app)
      .post('/api/admin/templates')
      .set(...as(admin))
      .send({
        tool: 'github',
        name: 'live read',
        permissions: ['metadata:read', 'issues:read', 'user:read'],
        resources: [repo],
        defaultTtlSeconds: 300,
        maxTtlSeconds: 600,
      })
      .expect(201);
    const { body } = await request(app)
      .post('/api/admin/sessions')
      .set(...as(admin))
      .send({ templateId: tpl.body.id, accountId: acc.body.id })
      .expect(201);
    const key = body.key as string;

    const user = await request(app)
      .get('/proxy/github/user')
      .set(...as(key))
      .expect(200);
    expect(user.body.login).toBe(acc.body.identity.login);

    const meta = await request(app)
      .get(`/proxy/github/repos/${repo}`)
      .set(...as(key))
      .expect(200);
    expect(String(meta.body.full_name).toLowerCase()).toBe(repo.toLowerCase());

    const issues = await request(app)
      .get(`/proxy/github/repos/${repo}/issues?per_page=1&state=all`)
      .set(...as(key))
      .expect(200);
    if (issues.headers.link) expect(issues.headers.link).toContain('/proxy/github/repos/');

    // Outside the template: denied locally, never reaches GitHub.
    await request(app)
      .get('/proxy/github/repos/torvalds/linux')
      .set(...as(key))
      .expect(403);
    await request(app)
      .get(`/proxy/github/repos/${repo}/pulls`)
      .set(...as(key))
      .expect(403);
    await request(app)
      .get('/proxy/github/rate_limit')
      .set(...as(key))
      .expect(200);
  });
});
