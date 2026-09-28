import { openGateway } from '../bootstrap.js';
import { loadConfig, loadEnvFile } from '../config.js';

// Run while the gateway is stopped: a running instance would overwrite the store with its own state.
loadEnvFile();
const gateway = await openGateway(loadConfig());
const token = await gateway.rotateAdminToken();
console.info(`New admin token (previous one is now invalid):\n  ${token}`);
