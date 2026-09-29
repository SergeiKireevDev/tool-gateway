import { ActivityLog } from './activity.js';
import type { GatewayConfig } from './config.js';
import { Gateway } from './gateway.js';
import { CryptoBox } from './store/crypto.js';
import { EncryptedStore } from './store/store.js';
import { createGitHubProvider } from './tools/github.js';
import { createMondayProvider } from './tools/monday.js';
import { ToolRegistry } from './tools/registry.js';

export async function openGateway(config: GatewayConfig): Promise<Gateway> {
  const crypto = await CryptoBox.fromKeyFile(config.keyFile);
  const store = await EncryptedStore.open(config.storeFile, crypto);
  const tools = new ToolRegistry([createGitHubProvider(), createMondayProvider()]);
  const gateway = new Gateway(store, crypto, tools, new ActivityLog());
  gateway.setAdminEmails(config.google?.adminEmails ?? []);
  return gateway;
}
