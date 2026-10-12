import { OUTPUT_CHUNK_BYTES } from './protocol.js';

/**
 * Streams `content` into chunks of about `OUTPUT_CHUNK_BYTES`, handing each to `put` with its
 * sequence number, so a large file is never held in memory whole. `check` sees the running size
 * before each piece is kept, and throws to abort. Returns the size.
 */
export async function writeChunks(
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  put: (seq: number, data: Buffer) => void,
  check: (size: number) => void,
): Promise<number> {
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let size = 0;
  let seq = 0;
  const flush = (): void => {
    if (pendingBytes === 0) return;
    put(seq, Buffer.concat(pending));
    seq += 1;
    pending.length = 0;
    pendingBytes = 0;
  };
  for await (const piece of content) {
    size += piece.length;
    check(size);
    pending.push(piece);
    pendingBytes += piece.length;
    if (pendingBytes >= OUTPUT_CHUNK_BYTES) flush();
  }
  flush();
  return size;
}
