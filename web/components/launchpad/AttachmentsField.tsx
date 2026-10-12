'use client';

import type { Api } from '@/lib/api';
import { type Attachment, formatBytes } from '@/lib/launchpad';
import { Button } from '../ui';

/** Longest file name the gateway accepts. */
const MAX_NAME_LENGTH = 200;
const UNSAFE_CHARS = /[^A-Za-z0-9._-]/g;
const ATTACHMENTS_PATH = '/launchpad/attachments';

/** The name a file gets in /home/agent/in: letters, digits, dots, dashes and underscores. */
export function attachmentName(file: File): string {
  const name = file.name.replace(UNSAFE_CHARS, '_').slice(-MAX_NAME_LENGTH);
  return name === '' || name === '.' || name === '..' ? 'file' : name;
}

/** Adds picked files to the list; a file named like one already there replaces it. */
function withFiles(files: File[], picked: FileList | null): File[] {
  const added = [...(picked ?? [])];
  const names = new Set(added.map(attachmentName));
  return [...files.filter((f) => !names.has(attachmentName(f))), ...added];
}

/** Uploads the files for a launch to come; returns their attachment ids. */
export async function uploadAttachments(api: Api, files: readonly File[]): Promise<string[]> {
  const ids: string[] = [];
  try {
    for (const file of files) {
      const name = encodeURIComponent(attachmentName(file));
      ids.push((await api<Attachment>('PUT', `${ATTACHMENTS_PATH}/${name}`, file)).id);
    }
  } catch (err) {
    await discardAttachments(api, ids);
    throw err;
  }
  return ids;
}

/** Deletes uploaded attachments no run was launched with (best effort). */
export async function discardAttachments(api: Api, ids: readonly string[]): Promise<void> {
  await Promise.all(
    ids.map((id) => api('DELETE', `${ATTACHMENTS_PATH}/${id}`).catch(() => undefined)),
  );
}

/** Files the member attaches to the launch: the agent finds them in /home/agent/in. */
export function AttachmentsField({
  shown,
  files,
  onChange,
}: {
  shown: boolean;
  files: File[];
  onChange: (files: File[]) => void;
}) {
  if (!shown) return null;
  return (
    <div>
      <span className="text-sm font-medium text-slate-700">Attachments</span>
      {files.length > 0 && (
        <ul className="mt-1 divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200">
          {files.map((f) => (
            <li
              key={attachmentName(f)}
              className="flex items-center justify-between px-3 py-1.5 text-sm"
            >
              <span className="font-mono">in/{attachmentName(f)}</span>
              <span className="flex items-center gap-3 text-xs text-slate-500">
                {formatBytes(f.size)}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onChange(files.filter((x) => x !== f));
                  }}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <input
        type="file"
        multiple
        aria-label="Attach files"
        className="mt-1 block text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
        onChange={(e) => {
          onChange(withFiles(files, e.target.files));
          e.target.value = '';
        }}
      />
      <span className="mt-1 block text-xs text-slate-500">
        Optional. Copied to /home/agent/in before the agent starts (up to 20 files). Tell it what to
        do with them in the task.
      </span>
    </div>
  );
}
