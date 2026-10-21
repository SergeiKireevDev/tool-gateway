'use client';

import { type Api, ApiError } from '@/lib/api';
import { HTTP_SERVER_ERROR } from '@/lib/http';
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

const KIB = 1024;
const MIB = KIB * KIB;
/** Largest file the gateway accepts, 1 GiB (it enforces its own limits). */
const MAX_FILE_BYTES = KIB * MIB;
const PART_MIB = 32;
/**
 * Files are sent in parts of this size, so that a proxy in front of the gateway with a request
 * size limit (e.g. 100 MB) lets them through; the gateway accepts parts of up to 32 MiB.
 */
const PART_BYTES = PART_MIB * MIB;
const PERCENT = 100;
/** Times a part is sent again after a network or server error. */
const PART_RETRIES = 3;

/** Whether sending a part again may help: a network error or a server error, not a refusal. */
const retryable = (err: unknown): boolean =>
  !(err instanceof ApiError) || err.status >= HTTP_SERVER_ERROR;

/** Sends one part of a file, again on network or server errors. */
async function sendPart(api: Api, path: string, offset: number, part: Blob): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await api('PUT', `${path}?offset=${offset}`, part);
      return;
    } catch (err) {
      if (attempt >= PART_RETRIES || !retryable(err)) throw err;
    }
  }
}

/** Uploads a file in parts; `onSent` hears the bytes sent of each part. Returns its id. */
async function uploadFile(api: Api, file: File, onSent: (bytes: number) => void): Promise<string> {
  const upload = await api<Attachment>('POST', ATTACHMENTS_PATH, { name: attachmentName(file) });
  const path = `${ATTACHMENTS_PATH}/${upload.id}`;
  try {
    for (let offset = 0; offset < file.size; offset += PART_BYTES) {
      const part = file.slice(offset, offset + PART_BYTES);
      await sendPart(api, `${path}/parts`, offset, part);
      onSent(part.size);
    }
    await api<Attachment>('POST', `${path}/complete`);
  } catch (err) {
    await discardAttachments(api, [upload.id]);
    throw err;
  }
  return upload.id;
}

/**
 * Uploads the files for a launch to come; returns their attachment ids. `onProgress` hears the
 * share of the bytes sent so far (0 to 1).
 */
export async function uploadAttachments(
  api: Api,
  files: readonly File[],
  onProgress: (share: number) => void = () => undefined,
): Promise<string[]> {
  const tooLarge = files.find((f) => f.size > MAX_FILE_BYTES);
  if (tooLarge) throw new Error(`${tooLarge.name} is larger than 1 GiB`);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  let sent = 0;
  const ids: string[] = [];
  try {
    for (const file of files) {
      ids.push(
        await uploadFile(api, file, (bytes) => {
          sent += bytes;
          onProgress(total === 0 ? 1 : sent / total);
        }),
      );
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

const LIMITS = 'Up to 20 files, 1 GiB each, 2 GiB in all.';
const DEFAULT_HINT =
  'Optional. Copied to /home/agent/in before the agent starts (up to 20 files, 1 GiB each, 2 GiB in all). Tell it what to do with them in the task.';

/** The share of the files uploaded so far. */
export function UploadProgress({ progress }: { progress: number }) {
  return (
    <span className="mt-1 block text-xs font-medium text-slate-700" role="status">
      Uploading… {Math.floor(progress * PERCENT)}%
    </span>
  );
}

/** Files the member attaches to the launch: the agent finds them in /home/agent/in. */
export function AttachmentsField({
  shown,
  files,
  onChange,
  progress = null,
  hint,
}: {
  shown: boolean;
  files: File[];
  onChange: (files: File[]) => void;
  /** Share of the files uploaded (0 to 1) while they are, else null. */
  progress?: number | null;
  /** What the files are for (the limits are added); an agent's attachments by default. */
  hint?: string;
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
        {hint === undefined ? DEFAULT_HINT : `${hint} ${LIMITS}`}
      </span>
      {progress !== null && <UploadProgress progress={progress} />}
    </div>
  );
}
