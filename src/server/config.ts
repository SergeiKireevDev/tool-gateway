import { existsSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 7420;
const MAX_PORT = 65535;

export interface GoogleSignInConfig {
  clientId: string;
  clientSecret: string;
  /** Lower-cased emails allowed to sign in as gateway admin. */
  adminEmails: string[];
}

/** OAuth client ("Desktop app") for "Sign in with Google" on Gmail accounts. */
export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface LaunchpadConfig {
  /**
   * `firecracker`: microVMs through `vmd` (production). `local-unsafe`: the runner as a plain
   * child process, without any isolation (development only).
   */
  driver: 'firecracker' | 'local-unsafe';
  /** `vmd`'s unix socket. */
  vmdSocket: string;
  /** Runner bundle the local driver executes. */
  runnerScript: string;
}

export interface GatewayConfig {
  host: string;
  port: number;
  /** Encrypted state file (accounts, templates, sessions). */
  storeFile: string;
  /** SQLite database: activity, agent runs, transcripts, LLM usage. No secrets. */
  dbFile: string;
  /**
   * Address of the bridge agent microVMs reach the gateway on, or null when agents are off.
   * Only the proxy and `/api/session` are served there.
   */
  vmHost: string | null;
  /** Agent launchpad: how runs are booted, or null when launching agents is off. */
  launchpad: LaunchpadConfig | null;
  /** Raw 256-bit master key used to encrypt the store. Kept outside the data dir by default. */
  keyFile: string;
  /** Public base URL of the gateway, used to rewrite pagination links and for OAuth redirects. */
  publicUrl: string;
  /** Admin sign-in with Google; null when not configured. */
  google: GoogleSignInConfig | null;
  /** Gmail sign-in; null when not configured (Gmail tokens can still be pasted). */
  gmail: GmailOAuthConfig | null;
}

/** Loads `.env` from the working directory if present; real environment variables win. */
export function loadEnvFile(file = '.env'): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Empty strings (e.g. `KEY=` placeholders in .env) count as unset. */
type Env = Record<string, string | undefined>;

const read = (env: Env, key: string): string | undefined => {
  const value = env[key]?.trim();
  return value === '' ? undefined : value;
};

export function loadConfig(env: Env = process.env): GatewayConfig {
  const host = read(env, 'GATEWAY_HOST') ?? '127.0.0.1';
  const port = Number(read(env, 'GATEWAY_PORT') ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > MAX_PORT) {
    throw new Error(`Invalid GATEWAY_PORT: ${env.GATEWAY_PORT ?? ''}`);
  }
  const dataDir = path.resolve(read(env, 'GATEWAY_DATA_DIR') ?? 'data');
  const publicUrl = (read(env, 'GATEWAY_PUBLIC_URL') ?? `http://${host}:${port}`).replace(
    /\/+$/,
    '',
  );
  if (!URL.canParse(publicUrl)) throw new Error(`Invalid GATEWAY_PUBLIC_URL: ${publicUrl}`);

  const clientId = read(env, 'GOOGLE_CLIENT_ID');
  const clientSecret = read(env, 'GOOGLE_CLIENT_SECRET');
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (or neither)');
  }
  const adminEmails = (read(env, 'GATEWAY_ADMIN_EMAILS') ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return {
    host,
    port,
    storeFile: path.join(dataDir, 'store.enc'),
    dbFile: path.join(dataDir, 'gateway.sqlite'),
    vmHost: readVmHost(env),
    launchpad: readLaunchpad(env, readVmHost(env)),
    keyFile: path.resolve(
      read(env, 'GATEWAY_KEY_FILE') ?? path.join(homedir(), '.local-gateway', 'master.key'),
    ),
    publicUrl,
    google: clientId && clientSecret ? { clientId, clientSecret, adminEmails } : null,
    gmail: readGmail(env),
  };
}

function readGmail(env: Env): GmailOAuthConfig | null {
  const clientId = read(env, 'GMAIL_CLIENT_ID');
  const clientSecret = read(env, 'GMAIL_CLIENT_SECRET');
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('Set both GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (or neither)');
  }
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function readVmHost(env: Env): string | null {
  const vmHost = read(env, 'GATEWAY_VM_HOST') ?? null;
  if (vmHost !== null && !isIPv4(vmHost)) {
    throw new Error(`Invalid GATEWAY_VM_HOST (an IPv4 address): ${vmHost}`);
  }
  return vmHost;
}

function readLaunchpad(env: Env, vmHost: string | null): LaunchpadConfig | null {
  const driver = read(env, 'LAUNCHPAD_VM_DRIVER');
  if (driver === undefined) return null;
  if (driver !== 'firecracker' && driver !== 'local-unsafe') {
    throw new Error(`Invalid LAUNCHPAD_VM_DRIVER (firecracker or local-unsafe): ${driver}`);
  }
  if (driver === 'firecracker' && vmHost === null) {
    throw new Error('LAUNCHPAD_VM_DRIVER=firecracker needs GATEWAY_VM_HOST (the VM bridge IP)');
  }
  return {
    driver,
    vmdSocket: read(env, 'LAUNCHPAD_VMD_SOCKET') ?? '/run/launchpad/vmd.sock',
    runnerScript: path.resolve(read(env, 'LAUNCHPAD_RUNNER_SCRIPT') ?? 'guest/dist/runner.js'),
  };
}

/** Base URL agent microVMs use to reach the gateway on the VM bridge. */
export function vmPublicUrl(config: Pick<GatewayConfig, 'vmHost' | 'port'>): string {
  if (!config.vmHost) throw new Error('GATEWAY_VM_HOST is not set');
  return `http://${config.vmHost}:${config.port}`;
}
