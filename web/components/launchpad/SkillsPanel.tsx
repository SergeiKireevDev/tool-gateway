'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { Skill, SkillSummary } from '@/lib/launchpad';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorBanner,
  Modal,
  SectionHeader,
} from '../ui';

const BASE = '/launchpad/skills';

/** The labels of these skills, most used first, with how many skills have each. */
function labelCounts(skills: readonly SkillSummary[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    for (const label of skill.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Shows every skill, or those with one label. */
function LabelFilter({
  skills,
  label,
  onPick,
}: {
  skills: readonly SkillSummary[];
  label: string | null;
  onPick: (label: string | null) => void;
}) {
  const counts = labelCounts(skills);
  if (counts.length === 0) return null;
  const chip = (value: string | null, text: string) => (
    <button
      key={value ?? ''}
      type="button"
      aria-pressed={label === value}
      onClick={() => {
        onPick(value);
      }}
      className={`rounded-full px-2.5 py-1 text-xs ring-1 ${
        label === value
          ? 'bg-indigo-600 text-white ring-indigo-600'
          : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'
      }`}
    >
      {text}
    </button>
  );
  return (
    <div className="mb-3 flex flex-wrap gap-2" aria-label="Labels">
      {chip(null, `All (${String(skills.length)})`)}
      {counts.map(([value, n]) => chip(value, `${value} (${String(n)})`))}
    </div>
  );
}

function SkillRow({
  skill,
  admin,
  onOpen,
  onDelete,
}: {
  skill: SkillSummary;
  admin: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <button
          type="button"
          className="font-mono text-sm font-medium text-indigo-600 hover:underline"
          onClick={onOpen}
        >
          {skill.name}
        </button>
        {skill.labels.map((label) => (
          <span key={label} className="ml-2">
            <Badge>{label}</Badge>
          </span>
        ))}
        <p className="text-xs text-slate-500">
          {skill.description || 'No description'}
          {admin && ` · ${skill.memberName}`}
          {` · updated ${formatDateTime(skill.updatedAt)}`}
          {skill.runId && ` · from run ${skill.runId}`}
        </p>
      </div>
      <Button
        variant="danger"
        size="sm"
        onClick={() => {
          if (window.confirm(`Delete the skill "${skill.name}"?`)) onDelete();
        }}
      >
        Delete
      </Button>
    </li>
  );
}

/**
 * The skill library: what agents learned during their runs (each run exports `SKILL.md` files).
 * Members see their own skills, the admin everyone's.
 */
export function SkillsPanel({ api, admin }: { api: Api; admin: boolean }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [open, setOpen] = useState<Skill | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failed = (err: unknown): void => {
    setError((err as Error).message);
  };

  const load = useCallback(
    () =>
      api<SkillSummary[]>('GET', BASE).then(setSkills, (err: unknown) => {
        setError((err as Error).message);
      }),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const remove = (id: string): void => {
    api('DELETE', `${BASE}/${id}`).then(() => {
      setError(null);
      setOpen(null);
      void load();
    }, failed);
  };

  return (
    <div>
      <SectionHeader
        title="Skill library"
        description="What agents learned during their runs, exported as skills (SKILL.md). A later run exporting a skill of the same name updates it. When the admin set up a platform model, it labels the skills by topic."
      />
      <ErrorBanner message={error} />
      {skills?.length === 0 && (
        <EmptyState title="No skills yet">
          Agents export what they learned when they finish a run: their skills show up here.
        </EmptyState>
      )}
      {skills && skills.length > 0 && (
        <LabelFilter skills={skills} label={label} onPick={setLabel} />
      )}
      {skills && skills.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-100">
            {skills
              .filter((skill) => label === null || skill.labels.includes(label))
              .map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  admin={admin}
                  onOpen={() => {
                    api<Skill>('GET', `${BASE}/${skill.id}`).then(setOpen, failed);
                  }}
                  onDelete={() => {
                    remove(skill.id);
                  }}
                />
              ))}
          </ul>
        </Card>
      )}
      <Modal
        open={open !== null}
        wide
        title={open?.name ?? ''}
        onClose={() => {
          setOpen(null);
        }}
      >
        {open && (
          <div className="space-y-3">
            <pre className="max-h-[60vh] overflow-auto rounded-md bg-slate-900 p-3 text-xs whitespace-pre-wrap text-slate-100">
              {open.content}
            </pre>
            <div className="flex justify-end">
              <CopyButton value={open.content} label="Copy SKILL.md" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
