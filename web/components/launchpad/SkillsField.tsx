'use client';

import type { SkillChoice } from '@/lib/launchpad';

/** Skills of the member's library the agent starts with, in /home/agent/skills. */
export function SkillsField({
  skills,
  value,
  onChange,
}: {
  skills: SkillChoice[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  if (skills.length === 0) return null;
  const picked = new Set(value);
  return (
    <fieldset>
      <legend className="text-sm font-medium text-slate-700">Skills</legend>
      <ul className="mt-1 max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg ring-1 ring-slate-200">
        {skills.map((s) => (
          <li key={s.name}>
            <label className="flex cursor-pointer items-start gap-2 px-3 py-1.5 text-sm hover:bg-slate-50">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={picked.has(s.name)}
                onChange={(e) => {
                  onChange(
                    e.target.checked ? [...value, s.name] : value.filter((n) => n !== s.name),
                  );
                }}
              />
              <span>
                <span className="font-mono">{s.name}</span>
                {s.description && (
                  <span className="block text-xs text-slate-500">{s.description}</span>
                )}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <span className="mt-1 block text-xs text-slate-500">
        Optional. What earlier agents learned, from your skill library: the agent starts with them
        in /home/agent/skills, and its improvements to them are kept.
      </span>
    </fieldset>
  );
}
