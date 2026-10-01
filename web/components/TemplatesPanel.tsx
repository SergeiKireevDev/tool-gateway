'use client';

import { useState } from 'react';
import { formatDuration } from '@/lib/format';
import { toolName } from '@/lib/grants';
import { DEFAULT_MAX_TTL_SECONDS, DEFAULT_TTL_SECONDS } from '@/lib/units';
import type { TemplateInput, TemplateSummary as Template, Tool } from '@/lib/types';
import type { PanelProps } from './AdminApp';
import { GrantList } from './GrantList';
import {
  Badge,
  Button,
  Card,
  DurationInput,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Modal,
  SectionHeader,
  Textarea,
} from './ui';

type Editing = { mode: 'create' } | { mode: 'edit'; template: Template } | null;

export function TemplatesPanel({ api, data, refresh }: PanelProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (tpl: Template): Promise<void> => {
    const active = data.sessions.filter(
      (s) => s.templateId === tpl.id && s.status === 'active',
    ).length;
    const warning = active > 0 ? `\n\n${active} active session key(s) will be revoked.` : '';
    if (!confirm(`Delete template "${tpl.name}"?${warning}`)) return;
    setError(null);
    try {
      await api('DELETE', `/templates/${tpl.id}`);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section>
      <SectionHeader
        title="Permission templates"
        description="A template defines what a session key may do: which operations, on which resources, and for how long. It can span several tools (e.g. open pull requests on GitHub and update items on monday.com); the key then uses one account per tool. Session keys snapshot their template when issued — editing a template does not widen existing keys."
        action={
          <Button
            disabled={data.tools.length === 0}
            onClick={() => {
              setEditing({ mode: 'create' });
            }}
          >
            + New template
          </Button>
        }
      />
      <div className="mb-4">
        <ErrorBanner message={error} />
      </div>

      {data.templates.length === 0 ? (
        <EmptyState title="No templates yet">
          Create a template such as “Read-only on my-org/*” to start issuing session keys.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {data.templates.map((tpl) => (
            <Card key={tpl.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{tpl.name}</h3>
                    {tpl.grants.map((g) => (
                      <Badge key={g.tool} tone="indigo">
                        {toolName(data.tools, g.tool)}
                      </Badge>
                    ))}
                  </div>
                  {tpl.description && (
                    <p className="mt-0.5 text-sm text-slate-500">{tpl.description}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setEditing({ mode: 'edit', template: tpl });
                    }}
                  >
                    Edit
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => void remove(tpl)}>
                    Delete
                  </Button>
                </div>
              </div>

              <div className="mt-4">
                <GrantList grants={tpl.grants} tools={data.tools} />
              </div>
              <p className="mt-4 text-xs text-slate-500">
                TTL: default {formatDuration(tpl.defaultTtlSeconds)}, max{' '}
                {formatDuration(tpl.maxTtlSeconds)}
              </p>
            </Card>
          ))}
        </div>
      )}

      <TemplateModal
        key={editing?.mode === 'edit' ? editing.template.id : (editing?.mode ?? 'closed')}
        editing={editing}
        onClose={() => {
          setEditing(null);
        }}
        onSaved={async () => {
          setEditing(null);
          await refresh();
        }}
        api={api}
        data={data}
      />
    </section>
  );
}

function TemplateModal({
  editing,
  onClose,
  onSaved,
  api,
  data,
}: {
  editing: Editing;
  onClose: () => void;
  onSaved: () => Promise<void>;
} & Pick<PanelProps, 'api' | 'data'>) {
  const existing = editing?.mode === 'edit' ? editing.template : null;
  const [form, setForm] = useState<Omit<TemplateInput, 'grants'>>(() => ({
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    defaultTtlSeconds: existing?.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS,
    maxTtlSeconds: existing?.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS,
  }));
  const [drafts, setDrafts] = useState(() => initialDrafts(data.tools, existing));
  // One tool is edited at a time; the others show a one-line summary.
  const [expanded, setExpanded] = useState<string | null>(() =>
    existing ? null : (data.tools[0]?.id ?? null),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const body: TemplateInput = {
      ...form,
      grants: data.tools.flatMap((t) => {
        const d = drafts[t.id];
        if (!d?.enabled) return [];
        const resources = d.resourcesText
          .split(/[\n,]/)
          .map((r) => r.trim())
          .filter(Boolean);
        return [{ tool: t.id, permissions: d.permissions, resources }];
      }),
    };
    try {
      if (existing) await api('PUT', `/templates/${existing.id}`, body);
      else await api('POST', '/templates', body);
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      open={editing !== null}
      title={existing ? `Edit “${existing.name}”` : 'New permission template'}
      onClose={onClose}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <Input
            required
            value={form.name}
            placeholder="e.g. Release agent"
            onChange={(e) => {
              set('name', e.target.value);
            }}
          />
        </Field>
        <Field label="Description (optional)">
          <Input
            value={form.description}
            onChange={(e) => {
              set('description', e.target.value);
            }}
          />
        </Field>

        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium text-slate-700">
            Tools{' '}
            <span className="font-normal text-slate-500">
              (one or more; a key gets one account per tool)
            </span>
          </legend>
          {data.tools.map((t) => (
            <GrantEditor
              key={t.id}
              tool={t}
              draft={drafts[t.id] ?? EMPTY_DRAFT}
              expanded={expanded === t.id}
              onExpand={(open) => {
                setExpanded(open ? t.id : null);
              }}
              onChange={(draft) => {
                setDrafts((d) => ({ ...d, [t.id]: draft }));
              }}
            />
          ))}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default TTL">
            <DurationInput
              value={form.defaultTtlSeconds}
              onChange={(v) => {
                set('defaultTtlSeconds', v);
              }}
            />
          </Field>
          <Field
            label="Maximum TTL"
            hint="Upper bound for keys issued from this template (≤ 7 days)."
          >
            <DurationInput
              value={form.maxTtlSeconds}
              onChange={(v) => {
                set('maxTtlSeconds', v);
              }}
            />
          </Field>
        </div>

        <ErrorBanner message={error} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : existing ? 'Save changes' : 'Create template'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Editor state of one tool's grant; disabled tools are left out of the template. */
interface GrantDraft {
  enabled: boolean;
  permissions: string[];
  resourcesText: string;
}

const EMPTY_DRAFT: GrantDraft = { enabled: false, permissions: [], resourcesText: '' };

/** One draft per tool, from the template being edited (a new template starts on the first tool). */
function initialDrafts(tools: Tool[], existing: Template | null): Record<string, GrantDraft> {
  return Object.fromEntries(
    tools.map((t, i) => {
      const grant = existing?.grants.find((g) => g.tool === t.id);
      const draft: GrantDraft = grant
        ? {
            enabled: true,
            permissions: grant.permissions,
            resourcesText: grant.resources.join('\n'),
          }
        : { ...EMPTY_DRAFT, enabled: !existing && i === 0 };
      return [t.id, draft];
    }),
  );
}

/** "Pull requests (write), Issues (read) · octo-org/*" */
function grantSummary(tool: Tool, draft: GrantDraft): string {
  const permissions = tool.permissions
    .filter((p) => draft.permissions.includes(p.id))
    .map((p) => p.label)
    .join(', ');
  const resources = draft.resourcesText
    .split(/[\n,]/)
    .map((r) => r.trim())
    .filter(Boolean);
  return `${permissions || 'No permissions selected'} · ${
    resources.length ? resources.join(', ') : 'all resources'
  }`;
}

/** One tool of the template: a compact row, expanded to pick permissions and resources. */
function GrantEditor({
  tool,
  draft,
  expanded,
  onExpand,
  onChange,
}: {
  tool: Tool;
  draft: GrantDraft;
  expanded: boolean;
  onExpand: (open: boolean) => void;
  onChange: (draft: GrantDraft) => void;
}) {
  const open = draft.enabled && expanded;
  const incomplete = draft.enabled && draft.permissions.length === 0;

  return (
    <div className={`rounded-lg ring-1 ${draft.enabled ? 'ring-indigo-300' : 'ring-slate-200'}`}>
      <div className="flex items-center gap-3 px-3 py-2">
        <label className="flex shrink-0 cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            className="size-4 accent-indigo-600"
            checked={draft.enabled}
            onChange={(e) => {
              onChange({ ...draft, enabled: e.target.checked });
              onExpand(e.target.checked);
            }}
          />
          <span className="text-sm font-medium">{tool.name}</span>
        </label>
        {draft.enabled && !open && (
          <span
            className={`min-w-0 flex-1 truncate text-xs ${incomplete ? 'text-amber-700' : 'text-slate-500'}`}
            title={grantSummary(tool, draft)}
          >
            {grantSummary(tool, draft)}
          </span>
        )}
        {draft.enabled && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => {
              onExpand(!open);
            }}
          >
            {open ? 'Done' : 'Edit'}
          </Button>
        )}
      </div>
      {open && <GrantFields tool={tool} draft={draft} onChange={onChange} />}
    </div>
  );
}

function GrantFields({
  tool,
  draft,
  onChange,
}: {
  tool: Tool;
  draft: GrantDraft;
  onChange: (draft: GrantDraft) => void;
}) {
  const togglePermission = (id: string): void => {
    onChange({
      ...draft,
      permissions: draft.permissions.includes(id)
        ? draft.permissions.filter((p) => p !== id)
        : [...draft.permissions, id],
    });
  };

  return (
    <div className="space-y-3 border-t border-slate-100 px-3 pt-3 pb-3">
      <div className="grid gap-1.5 sm:grid-cols-2">
        {tool.permissions.map((p) => {
          const checked = draft.permissions.includes(p.id);
          return (
            <label
              key={p.id}
              title={p.description}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm ring-1 transition ${
                checked ? 'bg-indigo-50 ring-indigo-300' : 'ring-slate-200 hover:bg-slate-50'
              }`}
            >
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-indigo-600"
                checked={checked}
                onChange={() => {
                  togglePermission(p.id);
                }}
              />
              <span className="truncate">{p.label}</span>
            </label>
          );
        })}
      </div>
      <Field label="Resource allowlist" hint={tool.resourceHelp}>
        <Textarea
          rows={2}
          value={draft.resourcesText}
          onChange={(e) => {
            onChange({ ...draft, resourcesText: e.target.value });
          }}
        />
      </Field>
    </div>
  );
}
