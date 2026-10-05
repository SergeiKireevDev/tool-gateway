import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadVmdConfig } from './config.js';
import { realHost } from './host.js';
import { createVmdServer, listenOnSocket } from './server.js';
import { VmManager } from './vmManager.js';

/** vmd: the root daemon that boots agent microVMs for the gateway's launchpad. */
async function main(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error('vmd must run as root');
  const config = loadVmdConfig();
  const vms = new VmManager(config, realHost);
  await vms.init();
  await mkdir(path.dirname(config.socket), { recursive: true, mode: 0o750 });
  const server = createVmdServer(vms);
  await listenOnSocket(server, config.socket, config.socketGid);
  console.info(
    `vmd listening on ${config.socket} (bridge ${config.bridge}, up to ${config.maxVms} VMs)`,
  );

  const shutdown = (): void => {
    server.close();
    void Promise.all(vms.list().map((vm) => vms.destroy(vm.vmId))).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
