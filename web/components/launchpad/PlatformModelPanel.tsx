'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Api } from '@/lib/api';
import type { PlatformModel } from '@/lib/launchpad';
import { Badge, Button, Card, ErrorBanner, Field, Input, Select } from '../ui';

const PATH = '/launchpad/platform-model';

interface Draft {
  url: string;
  api: PlatformModel['api'];
  model: string;
  /** '' keeps the current token. */
  token: string;
}

const draftOf = (current: PlatformModel | null): Draft => ({
  url: current?.url ?? '',
  api: current?.api ?? 'openai',
  model: current?.model ?? '',
  token: '',
});

/**
 * Admin: the platform model, an LLM endpoint (typically a local model) the gateway itself asks
 * for small decisions: a title for each run, labels for the skills agents export.
 */
export function PlatformModelPanel({ api }: { api: Api }) {
  const [current, setCurrent] = useState<PlatformModel | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const show = useCallback((platformModel: PlatformModel | null) => {
    setCurrent(platformModel);
    setDraft(draftOf(platformModel));
  }, []);
  const failed = (err: unknown): void => {
    setNotice(null);
    setError((err as Error).message);
  };

  useEffect(() => {
    api<{ platformModel: PlatformModel | null }>('GET', PATH).then(
      (res) => {
        show(res.platformModel);
      },
      (err: unknown) => {
        setError((err as Error).message);
      },
    );
  }, [api, show]);

  const save = (): void => {
    const { token, ...rest } = draft;
    api<{ platformModel: PlatformModel }>('PUT', PATH, token ? draft : rest).then((res) => {
      setError(null);
      setNotice('Saved.');
      show(res.platformModel);
    }, failed);
  };
  const remove = (): void => {
    if (!window.confirm('Remove the platform model? Runs and skills keep what it wrote.')) return;
    api('DELETE', PATH).then(() => {
      setError(null);
      setNotice(null);
      show(null);
    }, failed);
  };
  const test = (): void => {
    setBusy(true);
    api<{ title: string | null }>('POST', `${PATH}/test`)
      .then((res) => {
        setError(null);
        setNotice(`It named a sample task: “${res.title ?? '(no title)'}”`);
      }, failed)
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-slate-700">Platform model</h3>
      <p className="mb-3 text-sm text-slate-500">
        An LLM endpoint the gateway asks for its own small decisions: a short title for each run
        (webhook events included), and labels that group the skills agents export. Each run&apos;s
        task and each exported skill are sent to it, so prefer a local model. Agents never get it.
      </p>
      <Card className="p-5">
        <p className="mb-4 text-sm text-slate-600">
          {current ? (
            <Badge tone="indigo">On · {current.model}</Badge>
          ) : (
            <Badge>Off: runs are listed by their task</Badge>
          )}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Endpoint URL" hint="Requests go to <URL>/v1/…, e.g. http://ollama:11434">
            <Input
              value={draft.url}
              placeholder="https://llm.internal.example"
              onChange={(e) => {
                setDraft({ ...draft, url: e.target.value });
              }}
            />
          </Field>
          <Field label="Chat API">
            <Select
              value={draft.api}
              onChange={(e) => {
                setDraft({ ...draft, api: e.target.value as Draft['api'] });
              }}
            >
              <option value="openai">OpenAI (Chat Completions)</option>
              <option value="anthropic">Anthropic (Messages)</option>
            </Select>
          </Field>
          <Field label="Model">
            <Input
              value={draft.model}
              placeholder="qwen3:8b"
              onChange={(e) => {
                setDraft({ ...draft, model: e.target.value });
              }}
            />
          </Field>
          <Field
            label="Bearer token"
            hint={current?.hasToken ? 'Set. Leave empty to keep it.' : 'Optional.'}
          >
            <Input
              type="password"
              autoComplete="off"
              value={draft.token}
              onChange={(e) => {
                setDraft({ ...draft, token: e.target.value });
              }}
            />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <ErrorBanner message={error} />
            {notice && <p className="text-sm text-slate-600">{notice}</p>}
          </div>
          <div className="flex gap-2">
            {current && (
              <>
                <Button variant="danger" onClick={remove}>
                  Remove
                </Button>
                <Button variant="secondary" disabled={busy} onClick={test}>
                  {busy ? 'Asking…' : 'Try it'}
                </Button>
              </>
            )}
            <Button onClick={save}>Save platform model</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
