import { ActivityLog } from './activity.js';
import type { GatewayConfig } from './config.js';
import { Database } from './db/database.js';
import { Gateway } from './gateway.js';
import { CryptoBox } from './store/crypto.js';
import { EncryptedStore } from './store/store.js';
import { LlmUsageLog } from './llmUsage.js';
import { createGitHubProvider } from './tools/github.js';
import { createAnthropicProvider } from './tools/llm/anthropic.js';
import { createGeminiProvider } from './tools/llm/gemini.js';
import { createOpenAIProvider } from './tools/llm/openai.js';
import { createMondayProvider } from './tools/monday.js';
import { ToolRegistry } from './tools/registry.js';
import { createSlackProvider } from './tools/slack.js';

export interface Services {
  gateway: Gateway;
  db: Database;
}

export async function openGateway(config: GatewayConfig): Promise<Services> {
  const crypto = await CryptoBox.fromKeyFile(config.keyFile);
  const store = await EncryptedStore.open(config.storeFile, crypto);
  const db = Database.open(config.dbFile);
  const tools = new ToolRegistry([
    createGitHubProvider(),
    createMondayProvider(),
    createSlackProvider(),
    createAnthropicProvider(),
    createOpenAIProvider(),
    createGeminiProvider(),
  ]);
  const gateway = new Gateway(store, crypto, tools, new ActivityLog(db), new LlmUsageLog(db));
  gateway.setAdminEmails(config.google?.adminEmails ?? []);
  return { gateway, db };
}
