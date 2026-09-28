'use client';

import { useState } from 'react';
import { formatDuration } from '@/lib/format';
import type { Template, TemplateInput } from '@/lib/types';
import type { PanelProps } from './AdminApp';
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
  Select,
  Textarea,
} from './ui';

type Editing = { mode: 'create' } | { mode: 'edit'; template: Template } | null;

export function TemplatesPanel({ api, data, refresh }: PanelProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);

  const permissionLabel = (tool: string, id: string): string =>
    data.tools.find((t) => t.id === tool)?.permissions.find((p) => p.id === id)?.label ?? id;

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
        description="A template defines what a session key may do: which operations, on which resources, and for how long. Session keys snapshot their template when issued — editing a template does not widen existing keys."
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
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{tpl.name}</h3>
                    <Badge tone="indigo">
                      {data.tools.find((t) => t.id === tpl.tool)?.name ?? tpl.tool}
                    </Badge>
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

              <div className="mt-4 grid gap-4 text-sm md:grid-cols-3">
                <div className="md:col-span-2">
                  <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">
                    Permissions
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {tpl.permissions.map((p) => (
                      <Badge key={p} tone={p.endsWith(':read') ? 'slate' : 'amber'}>
                        {permissionLabel(tpl.tool, p)}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">
                    Resources
                  </p>
                  {tpl.resources.length === 0 ? (
                    <span className="text-amber-700">Unrestricted</span>
                  ) : (
                    <ul className="font-mono text-xs text-slate-700">
                      {tpl.resources.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                </div>
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
  const [form, setForm] = useState<TemplateInput>(() => ({
    tool: existing?.tool ?? data.tools[0]?.id ?? '',
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    permissions: existing?.permissions ?? [],
    resources: existing?.resources ?? [],
    defaultTtlSeconds: existing?.defaultTtlSeconds ?? 3600,
    maxTtlSeconds: existing?.maxTtlSeconds ?? 8 * 3600,
  }));
  const [resourcesText, setResourcesText] = useState(form.resources.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tool = data.tools.find((t) => t.id === form.tool);

  const set = <K extends keyof TemplateInput>(key: K, value: TemplateInput[K]): void => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const togglePermission = (id: string): void => {
    set(
      'permissions',
      form.permissions.includes(id)
        ? form.permissions.filter((p) => p !== id)
        : [...form.permissions, id],
    );
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const body: TemplateInput = {
      ...form,
      resources: resourcesText
        .split(/[\n,]/)
        .map((r) => r.trim())
        .filter(Boolean),
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input
              required
              value={form.name}
              placeholder="e.g. Read-only on my-org"
              onChange={(e) => {
                set('name', e.target.value);
              }}
            />
          </Field>
          <Field label="Tool">
            <Select
              value={form.tool}
              disabled={existing !== null}
              onChange={(e) => {
                setForm((f) => ({ ...f, tool: e.target.value, permissions: [] }));
              }}
            >
              {data.tools.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Description (optional)">
          <Input
            value={form.description}
            onChange={(e) => {
              set('description', e.target.value);
            }}
          />
        </Field>

        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Permissions</legend>
          <div className="mt-2 grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {tool?.permissions.map((p) => {
              const checked = form.permissions.includes(p.id);
              return (
                <label
                  key={p.id}
                  className={`flex cursor-pointer gap-3 rounded-lg p-3 ring-1 transition ${
                    checked ? 'bg-indigo-50 ring-indigo-300' : 'ring-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-indigo-600"
                    checked={checked}
                    onChange={() => {
                      togglePermission(p.id);
                    }}
                  />
                  <span>
                    <span className="block text-sm font-medium">{p.label}</span>
                    <span className="block text-xs text-slate-500">{p.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <Field label="Resource allowlist" hint={tool?.resourceHelp}>
          <Textarea
            rows={3}
            value={resourcesText}
            placeholder={'my-org/*\nsomeone/some-repo'}
            onChange={(e) => {
              setResourcesText(e.target.value);
            }}
          />
        </Field>

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
