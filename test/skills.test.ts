import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { installSkills, readSkills } from '../src/guest/runner.js';
import { RUNNER_LIMITS } from '../src/server/launchpad/protocol.js';
import { skillDescription } from '../src/server/launchpad/skills.js';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

let t: LaunchHarness;

beforeEach(async () => {
  t = await createLaunchHarness();
});

const skillMd = (name: string, description: string, body = 'Use `per_page=100`.'): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

/** Launches a run for the member and finishes it with these skills. */
async function runExporting(
  cookie: string,
  skills: { name: string; content: string }[],
  outcome = 'succeeded',
): Promise<string> {
  const res = await t
    .portal(cookie, 'post', '/runs')
    .send({ prompt: 'Sync the issues', templateId: t.ids.template, harness: 'claude-code' })
    .expect(201);
  await settle(t.launchpad);
  await t
    .runner(t.driver.lastConfig().runToken, 'post', '/finish')
    .send({ outcome, finalMessage: null, memory: null, error: null, skills })
    .expect(200);
  await settle(t.launchpad);
  return res.body.id as string;
}

interface SkillBody {
  id: string;
  name: string;
  description: string;
  runId: string;
  memberName: string;
  content?: string;
}

describe('skill library', () => {
  it('tells agents to export what they learned as skills', async () => {
    const alice = await t.member('alice');
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send({ prompt: 'Sync the issues', templateId: t.ids.template, harness: 'claude-code' })
      .expect(201);
    await settle(t.launchpad);
    const prompt = t.driver.lastConfig().systemPrompt;
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('`/home/agent/skills/<name>/SKILL.md`');
    expect(prompt).toContain('skill library');
  });

  it('keeps the skills a run exported for its member, replacing same-named ones', async () => {
    const alice = await t.member('alice');
    const first = await runExporting(alice.cookie, [
      { name: 'github-issues', content: skillMd('github-issues', 'Paginating GitHub issues') },
      { name: 'repo-ci', content: skillMd('repo-ci', '"How CI runs"') },
    ]);
    let list = (await t.portal(alice.cookie, 'get', '/skills').expect(200)).body as SkillBody[];
    expect(list.map((s) => [s.name, s.description, s.runId])).toEqual([
      ['github-issues', 'Paginating GitHub issues', first],
      ['repo-ci', 'How CI runs', first],
    ]);
    expect(list[0]).not.toHaveProperty('content');
    const firstId = list[0]?.id;

    // A failed run's lessons are kept too; a same-named skill is updated in place.
    const second = await runExporting(
      alice.cookie,
      [{ name: 'github-issues', content: skillMd('github-issues', 'Issues API, v2') }],
      'failed',
    );
    list = (await t.portal(alice.cookie, 'get', '/skills').expect(200)).body as SkillBody[];
    expect(list).toHaveLength(2);
    const updated = list.find((s) => s.name === 'github-issues');
    expect(updated).toMatchObject({ description: 'Issues API, v2', runId: second });
    expect(updated?.id).toBe(firstId);

    const one = await t.portal(alice.cookie, 'get', `/skills/${updated?.id ?? ''}`).expect(200);
    expect(one.body).toMatchObject({ name: 'github-issues', memberName: 'alice' });
    expect((one.body as SkillBody).content).toContain('Issues API, v2');
  });

  it('redacts credentials from skills', async () => {
    const alice = await t.member('alice');
    await runExporting(alice.cookie, [
      { name: 'leaky', content: skillMd('leaky', 'Oops', 'Token: ghp_abcdefghijklmnop1234') },
    ]);
    const [skill] = (await t.portal(alice.cookie, 'get', '/skills').expect(200))
      .body as SkillBody[];
    const one = await t.portal(alice.cookie, 'get', `/skills/${skill?.id ?? ''}`).expect(200);
    expect((one.body as SkillBody).content).toContain('ghp_[redacted]');
    expect((one.body as SkillBody).content).not.toContain('abcdefghijklmnop1234');
  });

  it('rejects invalid skills from the runner', async () => {
    const alice = await t.member('alice');
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send({ prompt: 'Sync the issues', templateId: t.ids.template, harness: 'claude-code' })
      .expect(201);
    await settle(t.launchpad);
    await t
      .runner(t.driver.lastConfig().runToken, 'post', '/finish')
      .send({
        outcome: 'succeeded',
        finalMessage: null,
        memory: null,
        error: null,
        skills: [{ name: '../etc', content: 'x' }],
      })
      .expect(400);
  });

  it('hides other members’ skills; the admin sees and deletes everyone’s', async () => {
    const alice = await t.member('alice');
    const bob = await t.member('bob');
    await runExporting(alice.cookie, [{ name: 'alpha', content: skillMd('alpha', 'A') }]);
    const [skill] = (await t.portal(alice.cookie, 'get', '/skills').expect(200))
      .body as SkillBody[];
    const id = skill?.id ?? '';
    expect((await t.portal(bob.cookie, 'get', '/skills').expect(200)).body).toEqual([]);
    await t.portal(bob.cookie, 'get', `/skills/${id}`).expect(404);
    await t.portal(bob.cookie, 'delete', `/skills/${id}`).expect(404);

    const all = (await t.admin('get', '/launchpad/skills').expect(200)).body as SkillBody[];
    expect(all.map((s) => [s.name, s.memberName])).toEqual([['alpha', 'alice']]);
    const filtered = await t.admin('get', `/launchpad/skills?memberId=${bob.id}`).expect(200);
    expect(filtered.body).toEqual([]);
    await t.admin('delete', `/launchpad/skills/${id}`).expect(204);
    expect((await t.portal(alice.cookie, 'get', '/skills').expect(200)).body).toEqual([]);
  });

  it('lets a member delete their own skills', async () => {
    const alice = await t.member('alice');
    await runExporting(alice.cookie, [{ name: 'alpha', content: skillMd('alpha', 'A') }]);
    const [skill] = (await t.portal(alice.cookie, 'get', '/skills').expect(200))
      .body as SkillBody[];
    await t.portal(alice.cookie, 'delete', `/skills/${skill?.id ?? ''}`).expect(204);
    expect((await t.portal(alice.cookie, 'get', '/skills').expect(200)).body).toEqual([]);
  });
});

describe('skills an agent starts with', () => {
  const launchBody = (extra: Record<string, unknown> = {}) => ({
    prompt: 'Sync the issues',
    templateId: t.ids.template,
    harness: 'claude-code',
    ...extra,
  });

  /** A member with two skills in their library. */
  async function memberWithSkills(): Promise<{ id: string; cookie: string }> {
    const alice = await t.member('alice');
    await runExporting(alice.cookie, [
      { name: 'github-issues', content: skillMd('github-issues', 'Paginating GitHub issues') },
      { name: 'repo-ci', content: skillMd('repo-ci', 'How CI runs') },
    ]);
    return alice;
  }

  it('lists the member’s skills in the launch options', async () => {
    const alice = await memberWithSkills();
    const bob = await t.member('bob');
    const options = await t.portal(alice.cookie, 'get', '/').expect(200);
    expect(options.body.skills).toEqual([
      { name: 'github-issues', description: 'Paginating GitHub issues' },
      { name: 'repo-ci', description: 'How CI runs' },
    ]);
    expect((await t.portal(bob.cookie, 'get', '/').expect(200)).body.skills).toEqual([]);
  });

  it('gives the agent the skills picked at launch', async () => {
    const alice = await memberWithSkills();
    const res = await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ skills: ['repo-ci', 'repo-ci'] }))
      .expect(201);
    expect(res.body.skills).toEqual(['repo-ci']);
    await settle(t.launchpad);
    const config = t.driver.lastConfig();
    expect(config.skills).toEqual(['repo-ci']);
    expect(config.systemPrompt).toContain('You start with these skills');
    expect(config.systemPrompt).toContain('`/home/agent/skills/repo-ci/SKILL.md`: How CI runs');
    expect(config.systemPrompt).not.toContain('github-issues');

    const fetched = await t.runner(config.runToken, 'get', '/skills').expect(200);
    expect(fetched.body.skills).toEqual([
      { name: 'repo-ci', content: skillMd('repo-ci', 'How CI runs') },
    ]);
    await request(t.vmApp).get('/runner/skills').expect(401);
  });

  it('gives no skills unless some are picked', async () => {
    const alice = await memberWithSkills();
    const res = await t.portal(alice.cookie, 'post', '/runs').send(launchBody()).expect(201);
    expect(res.body.skills).toEqual([]);
    await settle(t.launchpad);
    const config = t.driver.lastConfig();
    expect(config).not.toHaveProperty('skills');
    expect(config.systemPrompt).not.toContain('You start with these skills');
    const fetched = await t.runner(config.runToken, 'get', '/skills').expect(200);
    expect(fetched.body.skills).toEqual([]);
  });

  it('only gives skills of the member’s own library', async () => {
    await memberWithSkills();
    const bob = await t.member('bob');
    const res = await t
      .portal(bob.cookie, 'post', '/runs')
      .send(launchBody({ skills: ['repo-ci'] }))
      .expect(400);
    expect(res.body.message).toContain('Not in your skill library: repo-ci');
    await t
      .portal(bob.cookie, 'post', '/runs')
      .send(launchBody({ skills: ['../etc'] }))
      .expect(400);
  });

  it('leaves out skills deleted before the run starts', async () => {
    const alice = await memberWithSkills();
    // Fill the member's slots so the run stays queued.
    t.launchpad.runs.saveMemberLaunch({
      memberId: alice.id,
      launchEnabled: true,
      maxConcurrent: 1,
    });
    await t.portal(alice.cookie, 'post', '/runs').send(launchBody()).expect(201);
    await settle(t.launchpad);
    const blocker = t.driver.lastConfig().runToken;
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ skills: ['github-issues', 'repo-ci'] }))
      .expect(201);
    const list = (await t.portal(alice.cookie, 'get', '/skills').expect(200)).body as SkillBody[];
    const ci = list.find((s) => s.name === 'repo-ci');
    await t.portal(alice.cookie, 'delete', `/skills/${ci?.id ?? ''}`).expect(204);
    await t
      .runner(blocker, 'post', '/finish')
      .send({ outcome: 'succeeded', finalMessage: null, memory: null, error: null })
      .expect(200);
    await settle(t.launchpad);
    expect(t.driver.lastConfig().skills).toEqual(['github-issues']);
  });

  it('keeps the skills of schedules and triggers', async () => {
    const alice = await memberWithSkills();
    const schedule = await t
      .portal(alice.cookie, 'post', '/schedules')
      .send(launchBody({ skills: ['repo-ci'], preset: 'hourly' }))
      .expect(201);
    expect(schedule.body.skills).toEqual(['repo-ci']);

    const hook = await t
      .hooks(alice.cookie, 'post', '')
      .send({ name: 'issues', source: 'generic', auth: 'url' })
      .expect(201);
    const trigger = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send({
        instructions: 'Label the issue',
        templateId: t.ids.template,
        harness: 'claude-code',
        webhookId: hook.body.webhook.id as string,
        skills: ['github-issues'],
      })
      .expect(201);
    expect(trigger.body.skills).toEqual(['github-issues']);
    await request(t.app)
      .post(new URL(hook.body.url as string).pathname)
      .send({ type: 'Issue' })
      .expect(200);
    await settle(t.launchpad);
    expect(t.driver.lastConfig().skills).toEqual(['github-issues']);

    t.clock.now = new Date(t.clock.now.getTime() + 2 * 3_600_000);
    await t.scheduler.tick();
    await settle(t.launchpad);
    expect(t.driver.lastConfig().skills).toEqual(['repo-ci']);
  });

  it('changes the skills of an edited trigger', async () => {
    const alice = await memberWithSkills();
    const hook = await t
      .hooks(alice.cookie, 'post', '')
      .send({ name: 'issues', source: 'generic', auth: 'url' })
      .expect(201);
    const body = {
      instructions: 'Label the issue',
      templateId: t.ids.template,
      harness: 'claude-code',
      webhookId: hook.body.webhook.id as string,
    };
    const trigger = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send({ ...body, skills: ['github-issues'] })
      .expect(201);
    const path = `/triggers/${trigger.body.id as string}`;
    const edited = await t
      .portal(alice.cookie, 'put', path)
      .send({ ...body, skills: ['repo-ci'] })
      .expect(200);
    expect(edited.body.skills).toEqual(['repo-ci']);
    await request(t.app)
      .post(new URL(hook.body.url as string).pathname)
      .send({ type: 'Issue' })
      .expect(200);
    await settle(t.launchpad);
    expect(t.driver.lastConfig().skills).toEqual(['repo-ci']);

    const cleared = await t.portal(alice.cookie, 'put', path).send(body).expect(200);
    expect(cleared.body.skills).toEqual([]);
  });
});

describe('skill descriptions', () => {
  it('reads the frontmatter description, if any', () => {
    expect(skillDescription(skillMd('x', 'Does things'))).toBe('Does things');
    expect(skillDescription("---\ndescription: 'Quoted'\n---\n")).toBe('Quoted');
    expect(skillDescription('# No frontmatter\ndescription: nope')).toBe('');
  });
});

describe('runner skills', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string): void => {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, 'SKILL.md'), content);
  };

  it('reads each skill’s SKILL.md and reports the ones it skips', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'skills-'));
    write('beta', skillMd('beta', 'B'));
    write('alpha', skillMd('alpha', 'A'));
    write('Bad Name', 'x');
    mkdirSync(path.join(dir, 'empty'));
    writeFileSync(path.join(dir, 'stray.md'), 'not a skill');
    const { skills, problems } = readSkills(dir);
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'beta']);
    expect(skills[0]?.content).toContain('description: A');
    expect(problems).toEqual([
      'skipped skill Bad Name (invalid name)',
      'skipped skill empty (no SKILL.md)',
    ]);
  });

  it('does not follow symlinks out of the skills directory', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'skills-'));
    const secret = path.join(dir, 'secret.json');
    writeFileSync(secret, '{"runToken":"gwr_secret"}');
    mkdirSync(path.join(dir, 'sneaky'));
    symlinkSync(secret, path.join(dir, 'sneaky', 'SKILL.md'));
    const { skills, problems } = readSkills(dir);
    expect(skills).toEqual([]);
    expect(problems).toEqual(['skipped skill sneaky (no SKILL.md)']);
  });

  it('keeps at most the runner limit of skills', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'skills-'));
    for (let i = 0; i <= RUNNER_LIMITS.skills; i++)
      write(`skill-${String(i).padStart(2, '0')}`, 'x');
    const { skills, problems } = readSkills(dir);
    expect(skills).toHaveLength(RUNNER_LIMITS.skills);
    expect(problems).toHaveLength(1);
  });

  it('installs the skills the run starts with, owned by the agent', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'skills-'));
    const reporter = {
      fetchSkills: () =>
        Promise.resolve([
          { name: 'alpha', content: skillMd('alpha', 'A') },
          { name: '../escape', content: 'x' },
        ]),
    };
    const given = await installSkills(dir, reporter);
    expect([...given.keys()]).toEqual(['alpha']);
    expect(readSkills(dir).skills).toEqual([{ name: 'alpha', content: skillMd('alpha', 'A') }]);
  });

  it('exports only the given skills the agent changed, and new ones', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'skills-'));
    write('alpha', 'A');
    write('beta', 'B, improved');
    write('gamma', 'G');
    const given = new Map([
      ['alpha', 'A'],
      ['beta', 'B'],
    ]);
    expect(readSkills(dir, given).skills.map((s) => s.name)).toEqual(['beta', 'gamma']);
  });

  it('does not count unchanged given skills against the limit', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'skills-'));
    const given = new Map<string, string>();
    for (let i = 0; i < RUNNER_LIMITS.skills; i++) {
      const name = `given-${String(i).padStart(2, '0')}`;
      write(name, 'x');
      given.set(name, 'x');
    }
    write('new-skill', 'y');
    expect(readSkills(dir, given)).toEqual({
      skills: [{ name: 'new-skill', content: 'y' }],
      problems: [],
    });
  });

  it('finds nothing when the agent exported nothing', () => {
    expect(readSkills(path.join(tmpdir(), 'no-such-skills-dir'))).toEqual({
      skills: [],
      problems: [],
    });
  });
});
