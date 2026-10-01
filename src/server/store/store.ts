import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../units.js';
import type { CryptoBox } from './crypto.js';
import { migrate } from './migrate.js';
import { emptyState, type StoreState } from './types.js';

const AAD = 'local-gateway/store/v2';

/**
 * Whole-state store encrypted at rest (see CryptoBox).
 * State is held in memory; every mutation is persisted atomically (write tmp + rename).
 */
export class EncryptedStore {
  private state: StoreState = emptyState();
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly crypto: CryptoBox,
  ) {}

  static async open(file: string, crypto: CryptoBox): Promise<EncryptedStore> {
    const store = new EncryptedStore(file, crypto);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    let plaintext: string;
    try {
      plaintext = this.crypto.open(JSON.parse(raw), AAD);
    } catch {
      throw new Error(
        `Unable to decrypt ${this.file}: wrong master key or corrupted file. Refusing to start.`,
      );
    }
    this.state = migrate(JSON.parse(plaintext) as Parameters<typeof migrate>[0]);
  }

  read(): Readonly<StoreState> {
    return this.state;
  }

  /** Applies a mutation and persists it. Mutations are serialized. */
  async update<T>(mutate: (state: StoreState) => T): Promise<T> {
    const draft = structuredClone(this.state);
    const result = mutate(draft);
    this.state = draft;
    const snapshot = JSON.stringify(draft);
    const write = this.writeChain.then(() => this.persist(snapshot));
    // Keep the chain alive even if one write fails; the caller still sees the error.
    this.writeChain = write.catch(() => undefined);
    await write;
    return result;
  }

  private async persist(snapshot: string): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: PRIVATE_DIR_MODE });
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    await writeFile(tmp, JSON.stringify(this.crypto.seal(snapshot, AAD)), {
      mode: PRIVATE_FILE_MODE,
    });
    await rename(tmp, this.file);
  }
}
