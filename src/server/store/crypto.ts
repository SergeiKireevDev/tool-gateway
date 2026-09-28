/**
 * All cryptography goes through libsodium (misuse-resistant primitives, no hand-rolled constructions):
 *  - master key → per-purpose subkeys via crypto_kdf (BLAKE2b)
 *  - encryption at rest: XChaCha20-Poly1305 IETF AEAD with random 192-bit nonces
 *  - token storage: keyed BLAKE2b (crypto_generichash), compared in constant time
 *  - randomness: randombytes_buf (OS CSPRNG)
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sodium from 'libsodium-wrappers';

await sodium.ready;

const B64 = sodium.base64_variants.URLSAFE_NO_PADDING;
const ALG = 'xchacha20poly1305-ietf';
const KDF_CONTEXT = 'lgateway'; // must be exactly crypto_kdf_CONTEXTBYTES (8) bytes
const SUBKEY_STORE = 1;
const SUBKEY_TOKENS = 2;

export interface EncryptedEnvelope {
  v: 2;
  alg: typeof ALG;
  nonce: string;
  data: string;
}

export class CryptoBox {
  private constructor(
    private readonly storeKey: Uint8Array,
    private readonly tokenKey: Uint8Array,
  ) {}

  static fromMasterKey(master: Uint8Array): CryptoBox {
    if (master.length !== sodium.crypto_kdf_KEYBYTES) {
      throw new Error(`Master key must be ${sodium.crypto_kdf_KEYBYTES} bytes`);
    }
    return new CryptoBox(
      sodium.crypto_kdf_derive_from_key(
        sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
        SUBKEY_STORE,
        KDF_CONTEXT,
        master,
      ),
      sodium.crypto_kdf_derive_from_key(
        sodium.crypto_generichash_KEYBYTES,
        SUBKEY_TOKENS,
        KDF_CONTEXT,
        master,
      ),
    );
  }

  /**
   * Loads the master key from disk, creating it (mode 0600, parent dir 0700) on first run.
   * The file holds the key as hex.
   */
  static async fromKeyFile(keyFile: string): Promise<CryptoBox> {
    let master: Uint8Array;
    try {
      const raw = (await readFile(keyFile, 'utf8')).trim();
      try {
        master = sodium.from_hex(raw);
      } catch {
        throw new Error(`Master key file ${keyFile} is malformed (expected hex)`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      master = sodium.crypto_kdf_keygen();
      await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      await writeFile(keyFile, sodium.to_hex(master) + '\n', { mode: 0o600, flag: 'wx' });
      await chmod(keyFile, 0o600);
    }
    try {
      return CryptoBox.fromMasterKey(master);
    } finally {
      sodium.memzero(master);
    }
  }

  seal(plaintext: string, aad: string): EncryptedEnvelope {
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const data = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      aad,
      null,
      nonce,
      this.storeKey,
    );
    return {
      v: 2,
      alg: ALG,
      nonce: sodium.to_base64(nonce, B64),
      data: sodium.to_base64(data, B64),
    };
  }

  /** Throws if the envelope is malformed, was tampered with, or was sealed under another key/AAD. */
  open(envelope: unknown, aad: string): string {
    if (!isEnvelope(envelope)) throw new Error('Unsupported envelope format');
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      sodium.from_base64(envelope.data, B64),
      aad,
      sodium.from_base64(envelope.nonce, B64),
      this.storeKey,
    );
    return sodium.to_string(plaintext);
  }

  /** Keyed hash of a bearer token, safe to persist (useless without the master key). */
  hashToken(token: string): string {
    return sodium.to_hex(
      sodium.crypto_generichash(sodium.crypto_generichash_BYTES, token, this.tokenKey),
    );
  }

  /** Constant-time comparison of two hex digests. */
  static equalHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return sodium.memcmp(sodium.from_hex(a), sodium.from_hex(b));
    } catch {
      return false;
    }
  }
}

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.v === 2 && v.alg === ALG && typeof v.nonce === 'string' && typeof v.data === 'string';
}

export function randomToken(prefix: string, bytes = 32): string {
  return prefix + sodium.to_base64(sodium.randombytes_buf(bytes), B64);
}

export function randomId(): string {
  return sodium.to_base64(sodium.randombytes_buf(9), B64);
}
