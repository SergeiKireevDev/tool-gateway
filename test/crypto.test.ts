import { readFile, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CryptoBox, randomToken } from '../src/server/store/crypto.js';
import { EncryptedStore } from '../src/server/store/store.js';

const tmp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'gateway-crypto-'));

describe('CryptoBox', () => {
  it('creates a 0600 master key file on first use and reuses it', async () => {
    const keyFile = path.join(await tmp(), 'nested', 'master.key');
    const a = await CryptoBox.fromKeyFile(keyFile);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    const b = await CryptoBox.fromKeyFile(keyFile);
    expect(b.open(a.seal('hello', 'ctx'), 'ctx')).toBe('hello');
  });

  it('rejects tampered ciphertext, wrong AAD and wrong key', async () => {
    const a = await CryptoBox.fromKeyFile(path.join(await tmp(), 'k'));
    const b = await CryptoBox.fromKeyFile(path.join(await tmp(), 'k'));
    const env = a.seal('secret', 'ctx');
    const flipped = { ...env, data: (env.data.startsWith('A') ? 'B' : 'A') + env.data.slice(1) };
    expect(() => a.open(flipped, 'ctx')).toThrow();
    expect(() => a.open(env, 'other')).toThrow();
    expect(() => b.open(env, 'ctx')).toThrow();
    expect(() => a.open({ nope: true }, 'ctx')).toThrow(/Unsupported/);
  });

  it('uses fresh nonces', async () => {
    const box = await CryptoBox.fromKeyFile(path.join(await tmp(), 'k'));
    expect(box.seal('x', 'c').nonce).not.toBe(box.seal('x', 'c').nonce);
  });

  it('hashes tokens with a key-dependent hash', async () => {
    const a = await CryptoBox.fromKeyFile(path.join(await tmp(), 'k'));
    const b = await CryptoBox.fromKeyFile(path.join(await tmp(), 'k'));
    const token = randomToken('gws_');
    expect(a.hashToken(token)).toBe(a.hashToken(token));
    expect(a.hashToken(token)).not.toBe(b.hashToken(token));
    expect(CryptoBox.equalHex(a.hashToken(token), a.hashToken(token))).toBe(true);
    expect(CryptoBox.equalHex(a.hashToken(token), b.hashToken(token))).toBe(false);
    expect(CryptoBox.equalHex('ab', 'abcd')).toBe(false);
  });
});

describe('EncryptedStore', () => {
  it('never writes secrets in plaintext and reloads state', async () => {
    const dir = await tmp();
    const box = await CryptoBox.fromKeyFile(path.join(dir, 'k'));
    const file = path.join(dir, 'store.enc');
    const store = await EncryptedStore.open(file, box);
    await store.update((s) => {
      s.accounts.push({
        id: 'a1',
        tool: 'github',
        label: 'x',
        secret: 'ghp_SUPERSECRET',
        identity: {},
        createdAt: '',
        lastVerifiedAt: '',
      });
    });
    expect(await readFile(file, 'utf8')).not.toContain('SUPERSECRET');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const reopened = await EncryptedStore.open(file, box);
    expect(reopened.read().accounts[0]?.secret).toBe('ghp_SUPERSECRET');
  });

  it('refuses to start with the wrong key', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'store.enc');
    const store = await EncryptedStore.open(
      file,
      await CryptoBox.fromKeyFile(path.join(dir, 'k1')),
    );
    await store.update((s) => {
      s.adminTokenHash = 'x';
    });
    const other = await CryptoBox.fromKeyFile(path.join(dir, 'k2'));
    await expect(EncryptedStore.open(file, other)).rejects.toThrow(/Unable to decrypt/);
  });
});
