'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { Skill, SkillSummary } from '@/lib/launchpad';
import { Button, Card, CopyButton, EmptyState, ErrorBanner, Modal, SectionHeader } from '../ui';

const BASE = '/launchpad/skills';

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
        description="What agents learned during their runs, exported as skills (SKILL.md). A later run exporting a skill of the same name updates it."
      />
      <ErrorBanner message={error} />
      {skills?.length === 0 && (
        <EmptyState title="No skills yet">
          Agents export what they learned when they finish a run: their skills show up here.
        </EmptyState>
      )}
      {skills && skills.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-100">
            {skills.map((skill) => (
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
