import type { Database } from '../db/database.js';
import { redact } from '../db/redact.js';
import { badRequest, notFound } from '../errors.js';
import { randomId } from '../store/crypto.js';
import type { Actor } from './launchpad.js';
import { RUNNER_LIMITS, type RunnerSkill, SKILL_NAME_RE } from './protocol.js';
import { clip, type Run } from './runStore.js';

const MAX_DESCRIPTION_LENGTH = 1000;
const SKILL_NOT_FOUND = 'Skill not found';
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESCRIPTION_RE = /^description:[ \t]*(.*)$/m;

/**
 * A skill in the library: what an agent learned during a run (`SKILL.md`), kept for its member.
 * Each member has at most one skill per name; a later export of the same name replaces it.
 */
export interface Skill {
  id: string;
  memberId: string;
  memberName: string;
  name: string;
  /** From the `SKILL.md` frontmatter; empty when it has none. */
  description: string;
  content: string;
  /** The run that last exported it. */
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A skill without its content, as listed. */
export type SkillSummary = Omit<Skill, 'content'>;

interface SkillRow {
  id: string;
  member_id: string;
  member_name: string;
  name: string;
  description: string;
  content?: string;
  run_id: string | null;
  created_at: string;
  updated_at: string;
}

function toSummary(r: SkillRow): SkillSummary {
  return {
    id: r.id,
    memberId: r.member_id,
    memberName: r.member_name,
    name: r.name,
    description: r.description,
    runId: r.run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The `description` of a `SKILL.md`'s YAML frontmatter (one line, unquoted), or ''. */
export function skillDescription(content: string): string {
  const frontmatter = FRONTMATTER_RE.exec(content)?.[1] ?? '';
  const value = (DESCRIPTION_RE.exec(frontmatter)?.[1] ?? '').trim();
  const unquoted = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  return unquoted.slice(0, MAX_DESCRIPTION_LENGTH);
}

/** The skill library: skills agents exported, in the gateway database. */
export class Skills {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date,
  ) {}

  /** A member's skills (every member's for the admin), by name. */
  list(memberId?: string): SkillSummary[] {
    const columns = 'id, member_id, member_name, name, description, run_id, created_at, updated_at';
    const rows = (memberId === undefined
      ? this.db.sql.prepare(`SELECT ${columns} FROM skills ORDER BY name, member_name`).all()
      : this.db.sql
          .prepare(`SELECT ${columns} FROM skills WHERE member_id = ? ORDER BY name`)
          .all(memberId)) as unknown as SkillRow[];
    return rows.map(toSummary);
  }

  /** A skill the actor may see: members only their own (others look like they don't exist). */
  visible(actor: Actor, id: string): Skill {
    const row = this.db.sql.prepare('SELECT * FROM skills WHERE id = ?').get(id) as
      SkillRow | undefined;
    if (!row || (actor.kind === 'member' && row.member_id !== actor.member.id)) {
      throw notFound(SKILL_NOT_FOUND);
    }
    return { ...toSummary(row), content: row.content ?? '' };
  }

  /**
   * Checks the skills a launch gives its agent: names of skills in the member's library. Returns
   * them without duplicates, in the order given.
   */
  forLaunch(memberId: string, names: readonly string[]): string[] {
    const unique = [...new Set(names)];
    const known = new Set(this.byNames(memberId, unique).map((s) => s.name));
    const missing = unique.filter((n) => !known.has(n));
    if (missing.length > 0) {
      throw badRequest(`Not in your skill library: ${missing.join(', ')}`);
    }
    return unique;
  }

  /** The member's skills of these names that are (still) in the library, by name. */
  byNames(memberId: string, names: readonly string[]): Skill[] {
    if (names.length === 0) return [];
    const rows = this.db.sql
      .prepare(
        `SELECT * FROM skills WHERE member_id = ? AND name IN (${names.map(() => '?').join(', ')})
         ORDER BY name`,
      )
      .all(memberId, ...names) as unknown as SkillRow[];
    return rows.map((r) => ({ ...toSummary(r), content: r.content ?? '' }));
  }

  delete(actor: Actor, id: string): Skill {
    const skill = this.visible(actor, id);
    this.db.sql.prepare('DELETE FROM skills WHERE id = ?').run(skill.id);
    return skill;
  }

  /**
   * Keeps the skills a run exported in its member's library, replacing theirs of the same name.
   * Returns how many were kept; invalid ones are dropped (the runner already skips them).
   */
  saveFromRun(run: Run, skills: readonly RunnerSkill[]): number {
    const valid = skills
      .filter((s) => SKILL_NAME_RE.test(s.name) && s.content.trim() !== '')
      .slice(0, RUNNER_LIMITS.skills);
    const at = this.now().toISOString();
    const upsert = this.db.sql.prepare(
      `INSERT INTO skills (id, member_id, member_name, name, description, content, run_id,
                           created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (member_id, name) DO UPDATE SET
         member_name = excluded.member_name, description = excluded.description,
         content = excluded.content, run_id = excluded.run_id, updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      for (const skill of valid) {
        // Agents are told not to, but a credential must never reach the library.
        const content = clip(redact(skill.content), RUNNER_LIMITS.skillContent);
        upsert.run(
          randomId(),
          run.memberId,
          run.memberName,
          skill.name,
          skillDescription(content),
          content,
          run.id,
          at,
          at,
        );
      }
    });
    return valid.length;
  }
}
