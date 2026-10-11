'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { EnvironmentStatus, GuestEnvironment } from '@/lib/launchpad';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Input, Modal, Textarea } from '../ui';

/** Builds are checked this often while one is going. */
const BUILD_POLL_MS = 5000;
const MAX_DOCKERFILE_CHARS = 100_000;
const BASE = '/launchpad/environments';
const EXAMPLE = `FROM launchpad-guest:latest
RUN apt-get update \\
 && apt-get install -y --no-install-recommends golang-go \\
 && rm -rf /var/lib/apt/lists/*`;

const STATUS_TONES = { building: 'amber', ready: 'green', failed: 'red' } as const;
const STATUS_LABELS: Record<EnvironmentStatus, string> = {
  building: 'Building…',
  ready: 'Ready',
  failed: 'Build failed',
};

interface Draft {
  name: string;
  description: string;
  dockerfile: string;
}

const EMPTY: Draft = { name: '', description: '', dockerfile: '' };

/** The Dockerfile, pasted or read from an uploaded file. */
function DockerfileField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Field
      label="Dockerfile"
      hint="Paste it or upload it. The launchpad adds its runner on top: start FROM launchpad-guest:latest to keep Node 22, git and the agent CLIs."
    >
      <Textarea
        required
        rows={10}
        value={value}
        maxLength={MAX_DOCKERFILE_CHARS}
        placeholder={EXAMPLE}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
      <input
        type="file"
        aria-label="Upload a Dockerfile"
        className="mt-2 block text-xs text-slate-600 file:mr-2 file:rounded-md file:border-0 file:bg-slate-100 file:px-2.5 file:py-1 file:text-xs file:font-medium"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > MAX_DOCKERFILE_CHARS) {
            setError('This file is too large for a Dockerfile');
            return;
          }
          file.text().then(
            (text) => {
              setError(null);
              onChange(text);
            },
            (err: unknown) => {
              setError((err as Error).message);
            },
          );
        }}
      />
      <ErrorBanner message={error} />
    </Field>
  );
}

/** Adds an environment, or edits one (a changed Dockerfile is rebuilt). */
function EnvironmentForm({
  api,
  editing,
  onSaved,
}: {
  api: Api;
  editing: GuestEnvironment | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(editing ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (): void => {
    setBusy(true);
    const body = { name: draft.name, description: draft.description, dockerfile: draft.dockerfile };
    const sent = editing ? api('PUT', `${BASE}/${editing.id}`, body) : api('POST', BASE, body);
    sent.then(onSaved, (err: unknown) => {
      setError((err as Error).message);
      setBusy(false);
    });
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Field label="Name">
        <Input
          required
          value={draft.name}
          placeholder="Go toolchain"
          onChange={(e) => {
            setDraft({ ...draft, name: e.target.value });
          }}
        />
      </Field>
      <Field label="Description" hint="Shown to members when they pick it.">
        <Input
          value={draft.description}
          placeholder="Go 1.22 and golangci-lint"
          onChange={(e) => {
            setDraft({ ...draft, description: e.target.value });
          }}
        />
      </Field>
      <DockerfileField
        value={draft.dockerfile}
        onChange={(dockerfile) => {
          setDraft({ ...draft, dockerfile });
        }}
      />
      <ErrorBanner message={error} />
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {editing ? 'Save and rebuild if changed' : 'Add and build'}
        </Button>
      </div>
    </form>
  );
}

function EnvironmentRow({
  env,
  act,
  onEdit,
}: {
  env: GuestEnvironment;
  act: (method: string, path: string, body?: unknown) => void;
  onEdit: () => void;
}) {
  const path = `${BASE}/${env.id}`;
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{env.name}</span>
            <Badge tone={STATUS_TONES[env.status]}>{STATUS_LABELS[env.status]}</Badge>
          </div>
          <p className="text-xs text-slate-500">
            {env.description || 'No description'}
            {env.builtAt && ` · built ${formatDateTime(env.builtAt)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={env.enabled}
              onChange={(e) => {
                act('PATCH', path, { enabled: e.target.checked });
              }}
            />
            Members can pick it
          </label>
          <Button variant="secondary" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={env.status === 'building'}
            onClick={() => {
              act('POST', `${path}/rebuild`);
            }}
          >
            Rebuild
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              if (window.confirm(`Delete the guest environment "${env.name}"?`)) {
                act('DELETE', path);
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      {env.buildLog && (
        <details open={env.status === 'failed'}>
          <summary className="cursor-pointer text-xs text-slate-500">Build log</summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">
            {env.buildLog}
          </pre>
        </details>
      )}
    </li>
  );
}

/** Admin: the guest environments agents can be launched in, built from Dockerfiles. */
export function GuestEnvironmentsPanel({ api }: { api: Api }) {
  const [environments, setEnvironments] = useState<GuestEnvironment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // null: closed; 'new': adding; else the environment edited.
  const [form, setForm] = useState<GuestEnvironment | 'new' | null>(null);

  const load = useCallback(
    () =>
      api<GuestEnvironment[]>('GET', BASE).then(setEnvironments, (err: unknown) => {
        setError((err as Error).message);
      }),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const building = environments?.some((e) => e.status === 'building') ?? false;
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void load(), BUILD_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [building, load]);

  const act = (method: string, path: string, body?: unknown): void => {
    api(method, path, body).then(
      () => {
        setError(null);
        void load();
      },
      (err: unknown) => {
        setError((err as Error).message);
      },
    );
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Guest environments</h3>
          <p className="text-xs text-slate-500">
            VM images members can launch agents in, besides the default one. Only those members can
            pick are offered to them.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setForm('new');
          }}
        >
          Add environment
        </Button>
      </div>
      <ErrorBanner message={error} />
      {environments?.length === 0 && (
        <EmptyState title="No guest environments">
          Agents run in the default guest image. Add one from a Dockerfile to give them other tools.
        </EmptyState>
      )}
      {environments && environments.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-100">
            {environments.map((env) => (
              <EnvironmentRow
                key={env.id}
                env={env}
                act={act}
                onEdit={() => {
                  setForm(env);
                }}
              />
            ))}
          </ul>
        </Card>
      )}
      <Modal
        open={form !== null}
        wide
        title={form === 'new' || form === null ? 'Add a guest environment' : `Edit ${form.name}`}
        onClose={() => {
          setForm(null);
        }}
      >
        {form !== null && (
          <EnvironmentForm
            key={form === 'new' ? 'new' : form.id}
            api={api}
            editing={form === 'new' ? null : form}
            onSaved={() => {
              setForm(null);
              void load();
            }}
          />
        )}
      </Modal>
    </div>
  );
}
