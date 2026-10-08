import { isIPv4 } from 'node:net';
import path from 'node:path';

export interface VmdConfig {
  /** Unix socket the gateway talks to. */
  socket: string;
  /** Group id allowed to use the socket (the gateway user's group), or null for root only. */
  socketGid: number | null;
  /** Base rootfs image (ext4) and guest kernel, copied/linked into each jail. */
  rootfs: string;
  kernel: string;
  firecrackerBin: string;
  jailerBin: string;
  /** Jails live under `<jailBase>/firecracker/<vmId>/root`. */
  jailBase: string;
  /** Unprivileged uid/gid Firecracker runs as inside its jail. */
  jailUid: number;
  jailGid: number;
  /** Bridge the VM taps join, and its address (the gateway listens there). */
  bridge: string;
  bridgeAddress: string;
  prefixLength: number;
  maxVms: number;
  /** Service images: `<name>.ext4` plus its `<name>.json` manifest. */
  serviceDir: string;
  /** Where Firecracker's console output is kept, per VM. */
  logDir: string;
}

type Env = Record<string, string | undefined>;
const DEFAULT_PREFIX = 24;
const DEFAULT_MAX_VMS = 32;
const DEFAULT_JAIL_ID = 900;
/** Guest addresses are bridge + 1 .. bridge + maxVms within a /24. */
const MAX_VMS_PER_SUBNET = 250;

const read = (env: Env, key: string): string | undefined => {
  const v = env[key]?.trim();
  return v === '' ? undefined : v;
};

const int = (env: Env, key: string, fallback: number): number => {
  const v = read(env, key);
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${key}: ${v ?? ''}`);
  return n;
};

export function loadVmdConfig(env: Env = process.env): VmdConfig {
  const stateDir = path.resolve(read(env, 'VMD_STATE_DIR') ?? '/var/lib/launchpad');
  const bridgeAddress = read(env, 'VMD_BRIDGE_ADDRESS') ?? '172.30.0.1';
  if (!isIPv4(bridgeAddress)) throw new Error(`Invalid VMD_BRIDGE_ADDRESS: ${bridgeAddress}`);
  const maxVms = int(env, 'VMD_MAX_VMS', DEFAULT_MAX_VMS);
  if (maxVms < 1 || maxVms > MAX_VMS_PER_SUBNET)
    throw new Error(`VMD_MAX_VMS must be 1..${MAX_VMS_PER_SUBNET}`);
  return {
    socket: read(env, 'VMD_SOCKET') ?? '/run/launchpad/vmd.sock',
    socketGid: read(env, 'VMD_SOCKET_GID') === undefined ? null : int(env, 'VMD_SOCKET_GID', 0),
    rootfs: read(env, 'VMD_ROOTFS') ?? path.join(stateDir, 'rootfs.ext4'),
    kernel: read(env, 'VMD_KERNEL') ?? path.join(stateDir, 'vmlinux'),
    firecrackerBin: read(env, 'FIRECRACKER_BIN') ?? '/usr/local/bin/firecracker',
    jailerBin: read(env, 'JAILER_BIN') ?? '/usr/local/bin/jailer',
    jailBase: read(env, 'VMD_JAIL_BASE') ?? '/srv/launchpad-jail',
    jailUid: int(env, 'VMD_JAIL_UID', DEFAULT_JAIL_ID),
    jailGid: int(env, 'VMD_JAIL_GID', DEFAULT_JAIL_ID),
    bridge: read(env, 'VMD_BRIDGE') ?? 'lpbr0',
    bridgeAddress,
    prefixLength: int(env, 'VMD_PREFIX_LENGTH', DEFAULT_PREFIX),
    maxVms,
    serviceDir: read(env, 'VMD_SERVICE_DIR') ?? path.join(stateDir, 'services'),
    logDir: path.join(stateDir, 'logs'),
  };
}
