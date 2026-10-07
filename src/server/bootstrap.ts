import { ActivityLog } from './activity.js';
import { type GatewayConfig, vmPublicUrl } from './config.js';
import { Database } from './db/database.js';
import { Gateway } from './gateway.js';
import { Webhooks } from './webhooks.js';
import { Launchpad } from './launchpad/launchpad.js';
import { LocalProcessDriver } from './launchpad/localDriver.js';
import { RunStore } from './launchpad/runStore.js';
import { Scheduler } from './launchpad/scheduler.js';
import { VmdDriver } from './launchpad/vmdDriver.js';
import { CryptoBox } from './store/crypto.js';
import { EncryptedStore } from './store/store.js';
import { LlmUsageLog } from './llmUsage.js';
import { createGitHubProvider } from './tools/github.js';
import { createGmailProvider } from './tools/gmail.js';
import { createLinearProvider } from './tools/linear.js';
import { createAnthropicProvider } from './tools/llm/anthropic.js';
import { createGeminiProvider } from './tools/llm/gemini.js';
import { createOpenAIProvider } from './tools/llm/openai.js';
import { createMondayProvider } from './tools/monday.js';
import { ToolRegistry } from './tools/registry.js';
import { createSlackProvider } from './tools/slack.js';

export interface Services {
  gateway: Gateway;
  db: Database;
  launchpad: Launchpad | null;
  scheduler: Scheduler | null;
  webhooks: Webhooks;
}

export async function openGateway(config: GatewayConfig): Promise<Services> {
  const crypto = await CryptoBox.fromKeyFile(config.keyFile);
  const store = await EncryptedStore.open(config.storeFile, crypto);
  const db = Database.open(config.dbFile);
  const tools = new ToolRegistry([
    createGitHubProvider(),
    createMondayProvider(),
    createSlackProvider(),
    createLinearProvider(),
    createGmailProvider(fetch, config.gmail),
    createAnthropicProvider(),
    createOpenAIProvider(),
    createGeminiProvider(),
  ]);
  const gateway = new Gateway(store, crypto, tools, new ActivityLog(db), new LlmUsageLog(db));
  gateway.setAdminEmails(config.google?.adminEmails ?? []);
  const launchpad = openLaunchpad(config, gateway, db, crypto);
  const scheduler = launchpad && new Scheduler(db, gateway, launchpad);
  if (launchpad && scheduler) {
    launchpad.onFinished((run) => {
      scheduler.onRunFinished(run);
    });
  }
  const webhooks = new Webhooks(store, crypto, db, gateway.activity, config.publicUrl);
  return { gateway, db, launchpad, scheduler, webhooks };
}

function openLaunchpad(
  config: GatewayConfig,
  gateway: Gateway,
  db: Database,
  crypto: CryptoBox,
): Launchpad | null {
  const settings = config.launchpad;
  if (!settings) return null;
  const firecracker = settings.driver === 'firecracker';
  return new Launchpad({
    gateway,
    runs: new RunStore(db),
    crypto,
    driver: firecracker
      ? new VmdDriver(settings.vmdSocket)
      : new LocalProcessDriver(settings.runnerScript),
    vmGatewayUrl: firecracker ? vmPublicUrl(config) : config.publicUrl,
  });
}
