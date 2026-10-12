import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSkills } from '../src/guest/runner.js';
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

  it('finds nothing when the agent exported nothing', () => {
    expect(readSkills(path.join(tmpdir(), 'no-such-skills-dir'))).toEqual({
      skills: [],
      problems: [],
    });
  });
});
