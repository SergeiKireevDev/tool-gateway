import type { Database } from '../db/database.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { randomId } from '../store/crypto.js';
import { MS_PER_DAY } from '../units.js';
import { writeChunks } from './chunks.js';
import { MAX_OUTPUT_FILE_MIB, MAX_OUTPUT_TOTAL_MIB, MIB, type RunInput } from './protocol.js';

const MAX_NAME_LENGTH = 200;
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const MAX_ATTACHMENTS = 20;
/** Attachments not launched with within this long are deleted. */
const PENDING_DAYS = 1;
/** Largest part of a file uploaded in parts: below the request size limits of common proxies. */
const PART_MIB = 32;
const ATTACHMENT_NOT_FOUND = 'Attachment not found';
const UPLOAD_NOT_FOUND = 'Upload not found, or already completed';

/** Limits on the files a member attaches to a launch (and on those not launched with yet). */
export const ATTACHMENT_LIMITS = {
  /** Files per launch, and files uploaded but not launched with yet. */
  files: MAX_ATTACHMENTS,
  /** One file, in bytes. */
  fileBytes: MAX_OUTPUT_FILE_MIB * MIB,
  /** All files of a launch, and all files not launched with yet, in bytes. */
  totalBytes: MAX_OUTPUT_TOTAL_MIB * MIB,
  /** One part of a file uploaded in parts, in bytes. */
  partBytes: PART_MIB * MIB,
} as const;

/** A file a member attached to a launch: the agent finds it in `/home/agent/in/<name>`. */
export interface Attachment {
  id: string;
  name: string;
  size: number;
  /** The run it was launched with; null until then. */
  runId: string | null;
  createdAt: string;
}

interface AttachmentRow {
  id: string;
  name: string;
  size: number;
  run_id: string | null;
  created_at: string;
}

/** An attachment not launched with yet; an upload in progress has the size received so far. */
interface Unlaunched extends Attachment {
  complete: boolean;
}

const COLUMNS = 'id, name, size, run_id, created_at';

function toAttachment(r: AttachmentRow): Attachment {
  return { id: r.id, name: r.name, size: r.size, runId: r.run_id, createdAt: r.created_at };
}

/** Whether a name is a plain file name (no directory, no `.` or `..`). */
export function validAttachmentName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && NAME_RE.test(name) && name !== '.' && name !== '..';
}

/**
 * Files members attach to their launches. A member uploads them first (each gets an id), then
 * launches with their ids: the run claims them, and the runner copies them to `/home/agent/in`
 * before the agent starts. Content is stored in chunks, like output files.
 */
export class Attachments {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date,
  ) {}

  /** Holds the uploads a part is being written to, so that parts of one file never interleave. */
  private readonly writing = new Set<string>();

  /** Stores a file a member uploads in one request, streamed chunk by chunk, for a launch to come. */
  async upload(
    memberId: string,
    name: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<Attachment> {
    const { id } = this.begin(memberId, name);
    try {
      await this.write(memberId, id, 0, content, ATTACHMENT_LIMITS.fileBytes);
      return this.complete(memberId, id);
    } catch (err) {
      this.remove(id);
      throw err;
    }
  }

  /**
   * Starts uploading a file in parts (for files larger than a proxy in front of the gateway lets
   * through in one request): `append` its parts in order, then `complete` it.
   */
  begin(memberId: string, name: string): Attachment {
    if (!validAttachmentName(name)) {
      throw badRequest('Invalid file name: use letters, digits, dots, dashes and underscores');
    }
    if (this.unlaunched(memberId).length >= ATTACHMENT_LIMITS.files) {
      throw badRequest(`At most ${ATTACHMENT_LIMITS.files} files can wait for a launch`);
    }
    const id = randomId();
    const createdAt = this.now().toISOString();
    this.db.sql
      .prepare(
        'INSERT INTO run_attachments (id, member_id, run_id, name, size, created_at) VALUES (?, ?, NULL, ?, NULL, ?)',
      )
      .run(id, memberId, name, createdAt);
    return { id, name, size: 0, runId: null, createdAt };
  }

  /**
   * Appends a part (at most `ATTACHMENT_LIMITS.partBytes`) to an upload in progress. `offset` is
   * the size received so far: a part that failed can be sent again. Returns the size received.
   */
  async append(
    memberId: string,
    id: string,
    offset: number,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<{ received: number }> {
    return {
      received: await this.write(memberId, id, offset, content, ATTACHMENT_LIMITS.partBytes),
    };
  }

  /** Completes an upload in progress: the file can then be launched with. */
  complete(memberId: string, id: string): Attachment {
    const upload = this.inProgress(memberId, id);
    this.db.sql.prepare('UPDATE run_attachments SET size = ? WHERE id = ?').run(upload.size, id);
    return { id, name: upload.name, size: upload.size, runId: null, createdAt: upload.createdAt };
  }

  /** Writes a part of an upload at `offset`; a part that fails is removed whole. */
  private async write(
    memberId: string,
    id: string,
    offset: number,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    maxBytes: number,
  ): Promise<number> {
    const upload = this.inProgress(memberId, id);
    if (offset !== upload.size) {
      throw conflict(`Expected the part at offset ${upload.size}`);
    }
    const otherBytes = this.unlaunched(memberId)
      .filter((a) => a.id !== id)
      .reduce((sum, a) => sum + a.size, 0);
    const last = this.db.sql
      .prepare('SELECT MAX(seq) AS seq FROM run_attachment_chunks WHERE attachment_id = ?')
      .get(id) as { seq: number | null };
    const firstSeq = (last.seq ?? -1) + 1;
    const insert = this.db.sql.prepare(
      'INSERT INTO run_attachment_chunks (attachment_id, seq, data) VALUES (?, ?, ?)',
    );
    this.writing.add(id);
    try {
      const size = await writeChunks(
        content,
        (seq, data) => {
          insert.run(id, firstSeq + seq, data);
        },
        (sofar) => {
          if (sofar > maxBytes) throw badRequest('Part too large');
          if (offset + sofar > ATTACHMENT_LIMITS.fileBytes) throw badRequest('File too large');
          if (otherBytes + offset + sofar > ATTACHMENT_LIMITS.totalBytes) {
            throw badRequest('The files waiting for a launch exceed the total limit');
          }
        },
      );
      return offset + size;
    } catch (err) {
      this.db.sql
        .prepare('DELETE FROM run_attachment_chunks WHERE attachment_id = ? AND seq >= ?')
        .run(id, firstSeq);
      throw err;
    } finally {
      this.writing.delete(id);
    }
  }

  /** One of the member's uploads in progress, with nothing being written to it right now. */
  private inProgress(memberId: string, id: string): Unlaunched {
    const upload = this.unlaunched(memberId).find((a) => a.id === id && !a.complete);
    if (!upload) throw notFound(UPLOAD_NOT_FOUND);
    if (this.writing.has(id)) throw conflict('A part of this file is being uploaded');
    return upload;
  }

  /** Deletes one of the member's attachments no run was launched with yet, or an upload in progress. */
  discard(memberId: string, id: string): void {
    const found = this.unlaunched(memberId).some((a) => a.id === id);
    if (!found) throw notFound(ATTACHMENT_NOT_FOUND);
    this.remove(id);
  }

  /**
   * The member's uploaded attachments with these ids, checked for a launch: none launched with
   * yet, distinct names, within the per-launch limits.
   */
  forLaunch(memberId: string, ids: readonly string[]): Attachment[] {
    if (ids.length === 0) return [];
    if (ids.length > ATTACHMENT_LIMITS.files) {
      throw badRequest(`At most ${ATTACHMENT_LIMITS.files} files can be attached`);
    }
    const pending = new Map(this.pending(memberId).map((a) => [a.id, a]));
    const picked = [...new Set(ids)].map((id) => {
      const attachment = pending.get(id);
      if (!attachment) throw badRequest('Attachment not found, or already launched with');
      return attachment;
    });
    const names = new Set(picked.map((a) => a.name));
    if (names.size !== picked.length) throw badRequest('Two attached files have the same name');
    if (picked.reduce((sum, a) => sum + a.size, 0) > ATTACHMENT_LIMITS.totalBytes) {
      throw badRequest('The attached files exceed the total limit');
    }
    return picked;
  }

  /**
   * The attachments of a run that a relaunch of it gets again: all but those an uploaded file of
   * the same name replaces, within the per-launch limits with the uploaded ones.
   */
  forRelaunch(runId: string, uploaded: readonly Attachment[]): Attachment[] {
    const names = new Set(uploaded.map((a) => a.name));
    const kept = this.forRun(runId).filter((a) => !names.has(a.name));
    const all = [...uploaded, ...kept];
    if (all.length > ATTACHMENT_LIMITS.files) {
      throw badRequest(`At most ${ATTACHMENT_LIMITS.files} files can be attached`);
    }
    if (all.reduce((sum, a) => sum + a.size, 0) > ATTACHMENT_LIMITS.totalBytes) {
      throw badRequest('The attached files exceed the total limit');
    }
    return kept;
  }

  /** Gives a run copies of attachments checked by `forRelaunch` (the originals stay with theirs). */
  copy(memberId: string, runId: string, attachments: readonly Attachment[]): void {
    if (attachments.length === 0) return;
    const insert = this.db.sql.prepare(
      'INSERT INTO run_attachments (id, member_id, run_id, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const chunks = this.db.sql.prepare(
      `INSERT INTO run_attachment_chunks (attachment_id, seq, data)
       SELECT ?, seq, data FROM run_attachment_chunks WHERE attachment_id = ?`,
    );
    const createdAt = this.now().toISOString();
    this.db.transaction(() => {
      for (const a of attachments) {
        const id = randomId();
        insert.run(id, memberId, runId, a.name, a.size, createdAt);
        chunks.run(id, a.id);
      }
    });
  }

  /** Gives attachments checked by `forLaunch` to the run launched with them. */
  claim(runId: string, attachments: readonly Attachment[]): void {
    const claim = this.db.sql.prepare(
      'UPDATE run_attachments SET run_id = ? WHERE id = ? AND run_id IS NULL',
    );
    this.db.transaction(() => {
      for (const a of attachments) claim.run(runId, a.id);
    });
  }

  /** A run's attachments, by name. */
  forRun(runId: string): Attachment[] {
    const rows = this.db.sql
      .prepare(
        `SELECT ${COLUMNS} FROM run_attachments WHERE run_id = ? AND size IS NOT NULL ORDER BY name`,
      )
      .all(runId) as unknown as AttachmentRow[];
    return rows.map(toAttachment);
  }

  /** A run's attachments as runner inputs (`/home/agent/in/<name>`). */
  inputs(runId: string): RunInput[] {
    return this.forRun(runId).map((a) => ({ path: a.name, size: a.size }));
  }

  /** One of a run's attachments: its size and content, chunk by chunk (read lazily), or null. */
  stream(runId: string, name: string): { size: number; chunks: Iterable<Buffer> } | null {
    const attachment = this.forRun(runId).find((a) => a.name === name);
    return attachment ? { size: attachment.size, chunks: this.chunks(attachment.id) } : null;
  }

  /**
   * Deletes attachments no run was launched with after a day (or whose upload never completed),
   * and those of runs that finished longer ago than output files are kept.
   */
  purge(retentionDays: number): number {
    const now = this.now().getTime();
    const pendingBefore = new Date(now - PENDING_DAYS * MS_PER_DAY).toISOString();
    const finishedBefore = new Date(now - retentionDays * MS_PER_DAY).toISOString();
    return Number(
      this.db.sql
        .prepare(
          `DELETE FROM run_attachments
           WHERE (run_id IS NULL AND created_at <= ?)
              OR run_id IN (SELECT id FROM runs WHERE finished_at <= ?)`,
        )
        .run(pendingBefore, finishedBefore).changes,
    );
  }

  /** The member's attachments not launched with yet, uploads in progress included. */
  private unlaunched(memberId: string): Unlaunched[] {
    const rows = this.db.sql
      .prepare(
        `SELECT id, name, run_id, created_at, size IS NOT NULL AS complete,
                COALESCE(size, (SELECT COALESCE(SUM(length(data)), 0) FROM run_attachment_chunks
                                WHERE attachment_id = a.id)) AS size
         FROM run_attachments a WHERE member_id = ? AND run_id IS NULL ORDER BY created_at`,
      )
      .all(memberId) as unknown as (AttachmentRow & { complete: number })[];
    return rows.map((r) => ({ ...toAttachment(r), complete: r.complete === 1 }));
  }

  private pending(memberId: string): Attachment[] {
    return this.unlaunched(memberId)
      .filter((a) => a.complete)
      .map(({ complete: _complete, ...a }) => a);
  }

  private remove(id: string): void {
    this.db.sql.prepare('DELETE FROM run_attachments WHERE id = ?').run(id);
  }

  private *chunks(id: string): Generator<Buffer> {
    const read = this.db.sql.prepare(
      'SELECT data FROM run_attachment_chunks WHERE attachment_id = ? AND seq = ?',
    );
    for (let seq = 0; ; seq += 1) {
      const row = read.get(id, seq) as { data: Uint8Array } | undefined;
      if (!row) return;
      yield Buffer.from(row.data);
    }
  }
}
