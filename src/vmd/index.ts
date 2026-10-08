import { chown, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadVmdConfig } from './config.js';
import { realHost } from './host.js';
import { createVmdServer, listenOnSocket } from './server.js';
import { VmManager } from './vmManager.js';

const SOCKET_DIR_MODE = 0o750;

/** vmd: the root daemon that boots agent microVMs and service boxes for the gateway's launchpad. */
async function main(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error('vmd must run as root');
  const config = loadVmdConfig();
  const vms = new VmManager(config, realHost);
  await vms.init();
  const socketDir = path.dirname(config.socket);
  await mkdir(socketDir, { recursive: true, mode: SOCKET_DIR_MODE });
  // The gateway's group must be able to reach the socket inside.
  if (config.socketGid !== null) await chown(socketDir, 0, config.socketGid);
  const server = createVmdServer(vms);
  await listenOnSocket(server, config.socket, config.socketGid);
  console.info(
    `vmd listening on ${config.socket} (bridge ${config.bridge}, up to ${config.maxVms} VMs)`,
  );

  const shutdown = (): void => {
    server.close();
    void vms.destroyAll().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
