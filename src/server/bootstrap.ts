import { ActivityLog } from './activity.js';
import { type GatewayConfig, vmPublicUrl } from './config.js';
import { Database } from './db/database.js';
import { Gateway } from './gateway.js';
import { Webhooks } from './webhooks.js';
import { Launchpad } from './launchpad/launchpad.js';
import { LocalProcessDriver } from './launchpad/localDriver.js';
import { RunStore } from './launchpad/runStore.js';
import { Scheduler } from './launchpad/scheduler.js';
import { ServiceBoxes } from './launchpad/serviceBoxes.js';
import { Triggers } from './launchpad/triggers.js';
import { VmdDriver } from './launchpad/vmdDriver.js';
import { CryptoBox } from './store/crypto.js';
import { EncryptedStore } from './store/store.js';
import { LlmUsageLog } from './llmUsage.js';
import { createGitHubProvider } from './tools/github.js';
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
  triggers: Triggers | null;
  /** Service boxes (vmd only). */
  serviceBoxes: ServiceBoxes | null;
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
    createAnthropicProvider(),
    createOpenAIProvider(),
    createGeminiProvider(),
  ]);
  const gateway = new Gateway(store, crypto, tools, new ActivityLog(db), new LlmUsageLog(db));
  gateway.setAdminEmails(config.google?.adminEmails ?? []);
  const vmd =
    config.launchpad?.driver === 'firecracker' ? new VmdDriver(config.launchpad.vmdSocket) : null;
  const serviceBoxes = vmd && new ServiceBoxes(vmd, gateway.activity);
  const launchpad = openLaunchpad(config, gateway, db, crypto, { vmd, serviceBoxes });
  const scheduler = launchpad && new Scheduler(db, gateway, launchpad);
  if (launchpad && scheduler) {
    launchpad.onFinished((run) => {
      scheduler.onRunFinished(run);
    });
  }
  const webhooks = new Webhooks(store, crypto, db, gateway.activity, config.publicUrl);
  const triggers = launchpad && new Triggers(db, gateway, launchpad, webhooks);
  if (triggers) {
    webhooks.onDelivery((delivery) => {
      triggers.onDelivery(delivery);
    });
  }
  return { gateway, db, launchpad, scheduler, webhooks, triggers, serviceBoxes };
}

function openLaunchpad(
  config: GatewayConfig,
  gateway: Gateway,
  db: Database,
  crypto: CryptoBox,
  { vmd, serviceBoxes }: { vmd: VmdDriver | null; serviceBoxes: ServiceBoxes | null },
): Launchpad | null {
  const settings = config.launchpad;
  if (!settings) return null;
  return new Launchpad({
    gateway,
    runs: new RunStore(db),
    crypto,
    driver: vmd ?? new LocalProcessDriver(settings.runnerScript),
    vmGatewayUrl: vmd ? vmPublicUrl(config) : config.publicUrl,
    serviceBoxes,
  });
}
