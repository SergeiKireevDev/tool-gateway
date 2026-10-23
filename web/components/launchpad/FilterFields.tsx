import { splitList, type TriggerFilters } from '@/lib/launchpad';
import { Field, Input } from '../ui';

/** A trigger's deterministic filters, as typed: comma-separated lists. */
export type FilterDraft = Record<keyof TriggerFilters, string>;
export const NO_FILTERS: FilterDraft = { contains: '', statusChangedTo: '', assignedTo: '' };

interface FilterField {
  key: keyof TriggerFilters;
  label: string;
  hint: string;
  placeholder: string;
}

const FILTER_FIELDS: FilterField[] = [
  {
    key: 'contains',
    label: 'Contains',
    hint: 'Only events whose payload contains one of these keywords.',
    placeholder: 'crash, urgent',
  },
  {
    key: 'statusChangedTo',
    label: 'Status changed to',
    hint: 'Only events that move an item to one of these statuses.',
    placeholder: 'Todo, merged',
  },
  {
    key: 'assignedTo',
    label: 'Assigned to',
    hint: 'Only events that assign an item to one of these people (name, email, login or id).',
    placeholder: 'octocat, ada@example.com',
  },
];

export const toFilters = (f: FilterDraft): TriggerFilters => ({
  contains: splitList(f.contains),
  statusChangedTo: splitList(f.statusChangedTo),
  assignedTo: splitList(f.assignedTo),
});

export const toDraft = (f: TriggerFilters): FilterDraft => ({
  contains: f.contains.join(', '),
  statusChangedTo: f.statusChangedTo.join(', '),
  assignedTo: f.assignedTo.join(', '),
});

/** Optional conditions on the event, checked before an agent is launched. */
export function FilterFields({
  filters,
  setFilters,
}: {
  filters: FilterDraft;
  setFilters: (v: FilterDraft) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {FILTER_FIELDS.map((f) => (
        <Field key={f.key} label={f.label} hint={`${f.hint} Comma-separated; empty: any.`}>
          <Input
            value={filters[f.key]}
            onChange={(e) => {
              setFilters({ ...filters, [f.key]: e.target.value });
            }}
            placeholder={f.placeholder}
          />
        </Field>
      ))}
    </div>
  );
}
