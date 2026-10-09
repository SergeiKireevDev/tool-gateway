import type { LlmEndpointApi } from '../tools/types.js';

/**
 * Contract between the launchpad (gateway side) and the runner inside an agent microVM. The
 * runner reads a `RunnerConfig` from its config drive, then reports to the gateway's VM listener
 * under `/runner/*` with the run token. Shared by the server and the guest bundle.
 */

const KIB = 1024;
const MIB = KIB * KIB;
const MAX_OUTPUT_FILE_MIB = 10;
const MAX_OUTPUT_TOTAL_MIB = 50;
const MAX_MEMORY_KIB = 64;

export const RUN_TOKEN_PREFIX = 'gwr_';
/** Size of the raw config drive; the JSON config is NUL-padded to it. */
export const CONFIG_DRIVE_BYTES = MIB;

/** Agent CLIs a member can launch. */
export const HARNESSES = ['claude-code', 'codex', 'gemini', 'pi'] as const;
export type Harness = (typeof HARNESSES)[number];
/**
 * The execution container: no agent CLI, the runner runs a script written beforehand (by a
 * workflow's planning step). The script reaches a custom LLM endpoint and the template's tools.
 */
export const SCRIPT_HARNESS = 'script';
/** Everything a run can start: the agent CLIs and the execution container. */
export const RUN_HARNESSES = [...HARNESSES, SCRIPT_HARNESS] as const;
export type RunHarness = (typeof RUN_HARNESSES)[number];
/** The file the planning step of a workflow writes its script to, in its output files. */
export const SCRIPT_FILE = 'script.mjs';

/** `custom`: an endpoint configured in the template, speaking one of `LLM_ENDPOINT_APIS`. */
export const LLM_PROVIDERS = ['anthropic', 'openai', 'gemini', 'custom'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export const CUSTOM_PROVIDER = 'custom' satisfies LlmProvider;

/** Model APIs each harness can talk to, in order of preference. */
export const HARNESS_PROVIDERS: Record<RunHarness, readonly LlmProvider[]> = {
  'claude-code': ['anthropic', CUSTOM_PROVIDER],
  codex: ['openai', CUSTOM_PROVIDER],
  gemini: ['gemini'],
  pi: ['anthropic', 'openai', 'gemini', CUSTOM_PROVIDER],
  [SCRIPT_HARNESS]: [CUSTOM_PROVIDER],
};

/** Chat APIs of custom endpoints each harness can talk to (Codex needs OpenAI's Responses API). */
export const HARNESS_ENDPOINT_APIS: Record<RunHarness, readonly LlmEndpointApi[]> = {
  'claude-code': ['anthropic'],
  codex: ['openai'],
  gemini: [],
  pi: ['anthropic', 'openai'],
  [SCRIPT_HARNESS]: ['anthropic', 'openai'],
};

/** Everything the runner needs, written to the VM's config drive (readable by root only). */
export interface RunnerConfig {
  runId: string;
  /** Authenticates the runner's reports (`/runner/*`); never given to the agent. */
  runToken: string;
  /** Gateway base URL as seen from the VM (the VM bridge listener). */
  gatewayUrl: string;
  /** The agent's session key: tools and LLM calls through the gateway. */
  sessionKey: string;
  harness: RunHarness;
  /**
   * Model API (through the gateway) and model the harness uses; null model = its default.
   * `api`: the chat API of a custom endpoint (always set, with a model, for `custom`).
   */
  llm: { provider: LlmProvider; model: string | null; api?: LlmEndpointApi };
  /** MCP tool names of the gateway tools, for harnesses that allowlist tools. */
  gatewayTools: string[];
  /**
   * HTTPS domains the agent may reach through the gateway's egress proxy. When any, the runner
   * sets `HTTPS_PROXY` for the agent. Absent in configs from older gateways.
   */
  egressDomains?: string[];
  /** The task; for the `script` harness, the script itself. */
  prompt: string;
  /** Unused by the `script` harness. */
  systemPrompt: string;
  /** `MEMORY.md` carried over from the previous run of a schedule, or null. */
  memory: string | null;
  /** The runner stops the agent at this time (ISO), before the VM is killed. */
  deadline: string;
  /** Guest network (when the kernel command line didn't configure it). */
  network: { address: string; prefixLength: number; gateway: string };
}

/** Normalized transcript event, whatever the harness. */
export type RunEventType =
  | 'status'
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'usage'
  | 'log'
  | 'error'
  | 'final';

export interface RunEvent {
  /** Monotonic per run, assigned by the runner (deduplicates retried batches). */
  seq: number;
  at: string;
  type: RunEventType;
  /** Human-readable summary, shown in the live log. */
  text: string;
  /** Tool calls/results: the tool and its call id, linking a result to its call. */
  tool?: string;
  callId?: string;
  /** Structured details (tool input, usage numbers…), size-capped by the server. */
  data?: unknown;
}

export interface RunnerEventsBody {
  events: RunEvent[];
}

export type RunnerOutcome = 'succeeded' | 'failed' | 'timed_out';

export interface RunnerFinishBody {
  outcome: RunnerOutcome;
  finalMessage: string | null;
  /** Updated `MEMORY.md`, or null when the agent didn't write one. */
  memory: string | null;
  error: string | null;
}

/** Limits the server enforces on runner reports. */
export const RUNNER_LIMITS = {
  /** Events per batch. */
  batchEvents: 500,
  /** Text of one event, in characters. */
  eventText: 20_000,
  /** JSON of one event's `data`, in characters. */
  eventData: 50_000,
  /** One output file, in bytes. */
  outputFileBytes: MAX_OUTPUT_FILE_MIB * MIB,
  /** All output files of a run, in bytes. */
  outputTotalBytes: MAX_OUTPUT_TOTAL_MIB * MIB,
  /** Output files per run. */
  outputFiles: 200,
  /** `MEMORY.md`, in characters. */
  memory: MAX_MEMORY_KIB * KIB,
  finalMessage: 100_000,
} as const;
