import { fileURLToPath } from 'node:url';
import nextModule from 'next';
import { openGateway } from './bootstrap.js';
import { loadConfig, loadEnvFile, vmPublicUrl } from './config.js';
import { createApp, createVmApp } from './http/app.js';

// `next` is CommonJS: at runtime the default import *is* the factory, but its typings
// model it as an ES module with a `default` export.
const createNext = nextModule as unknown as typeof nextModule.default;

const FLUSH_INTERVAL_MS = 15_000;
const LAUNCHPAD_REAP_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const { gateway, db, launchpad } = await openGateway(config);

  if (!gateway.hasAdminToken()) {
    const token = await gateway.rotateAdminToken();
    console.info(
      [
        '',
        '  First start: an admin token was generated. It is shown only once — store it safely.',
        `    ${token}`,
        '  Lost it? Stop the gateway and run `npm run admin:reset-token`.',
        '',
      ].join('\n'),
    );
  }

  const dev = process.env.NODE_ENV !== 'production';
  const web = createNext({
    dev,
    dir: fileURLToPath(new URL('../../web', import.meta.url)),
    hostname: config.host,
    port: config.port,
  });
  await web.prepare();
  const handleWeb = web.getRequestHandler();

  const app = createApp(gateway, config, { launchpad });
  // Everything not handled by the gateway (admin UI pages, assets) goes to Next.js.
  app.all('/{*splat}', (req, res) => void handleWeb(req, res));

  const server = app.listen(config.port, config.host, () => {
    console.info(`Local gateway listening on ${config.publicUrl} (${dev ? 'dev' : 'production'})`);
    console.info(`  store: ${config.storeFile}\n  key:   ${config.keyFile}`);
    if (config.google) {
      console.info(`  Google sign-in: on — redirect URI ${config.publicUrl}/auth/google/callback`);
      if (config.google.adminEmails.length === 0) {
        console.warn('  ⚠ GATEWAY_ADMIN_EMAILS is empty: nobody can sign in with Google.');
      }
    } else {
      console.info('  Google sign-in: off (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env)');
    }
  });

  // Agent microVMs reach the gateway on the VM bridge, where only the proxy is served.
  const vmServer = config.vmHost
    ? createVmApp(gateway, { ...config, publicUrl: vmPublicUrl(config) }, { launchpad }).listen(
        config.port,
        config.vmHost,
        () => {
          console.info(`  agent VMs: ${vmPublicUrl(config)} (proxy only)`);
        },
      )
    : null;

  if (launchpad) {
    await launchpad.recover();
    launchpad.startTimers(LAUNCHPAD_REAP_INTERVAL_MS);
    console.info(`  agent launchpad: on (${launchpad.driverName})`);
    if (launchpad.driverName === 'local-unsafe') {
      console.warn(
        '  ⚠ LAUNCHPAD_VM_DRIVER=local-unsafe: agents run unisolated. Development only.',
      );
    }
  }

  const timer = setInterval(() => {
    gateway.flush().catch((err: unknown) => {
      console.error('Failed to flush usage stats', err);
    });
  }, FLUSH_INTERVAL_MS);

  const shutdown = (): void => {
    clearInterval(timer);
    launchpad?.stopTimers();
    server.close();
    vmServer?.close();
    void gateway.flush().finally(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
