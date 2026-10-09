import { z } from 'zod';
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from '../errors.js';
import type { Gateway, RunToolScope } from '../gateway.js';
import type { CryptoBox } from '../store/crypto.js';
import { randomId, randomToken } from '../store/crypto.js';
import type { Member, SessionIssuer, Template, ToolGrant } from '../store/types.js';
import { modelAllowed } from '../tools/llm/common.js';
import type { LlmEndpointApi } from '../tools/types.js';
import { MS_PER_DAY, MS_PER_SECOND, SECONDS_PER_MINUTE } from '../units.js';
import {
  CUSTOM_PROVIDER,
  HARNESS_ENDPOINT_APIS,
  HARNESS_PROVIDERS,
  HARNESSES,
  type Harness,
  LLM_PROVIDERS,
  type LlmProvider,
  RUN_TOKEN_PREFIX,
  type RunEvent,
  type RunnerConfig,
  type RunnerFinishBody,
  RUNNER_LIMITS,
} from './protocol.js';
import {
  ACTIVE_STATUSES,
  clip,
  isActive,
  type Run,
  type RunPatch,
  type RunStatus,
  type RunStore,
} from './runStore.js';
import { buildSystemPrompt, gatewayToolName, type PromptGrant } from './systemPrompt.js';
import type { VmDriver } from './vmDriver.js';

/** Session keys outlive the run's timeout by this much, so the agent is stopped first. */
const KEY_MARGIN_MINUTES = 5;
export const KEY_MARGIN_SECONDS = KEY_MARGIN_MINUTES * SECONDS_PER_MINUTE;
/** Shortest run a template's max TTL must allow. */
const MIN_RUN_MINUTES = 5;
const MIN_RUN_SECONDS = MIN_RUN_MINUTES * SECONDS_PER_MINUTE;
/** The VM is killed this long after the run's deadline if the runner didn't stop it. */
const KILL_GRACE_SECONDS = 2 * SECONDS_PER_MINUTE;
/** A run still provisioning after this long is failed. */
const PROVISION_TIMEOUT_MINUTES = 5;
const PROVISION_TIMEOUT_MS = PROVISION_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
/** A VM gets this long to report back after exiting before its run is failed. */
const EXIT_REPORT_GRACE_SECONDS = 30;
const EXIT_REPORT_GRACE_MS = EXIT_REPORT_GRACE_SECONDS * MS_PER_SECOND;
export const MAX_PROMPT_LENGTH = 50_000;
const MAX_MODEL_LENGTH = 100;
const MAX_ACCOUNTS = 20;
const MAX_OUTPUT_PATH = 200;
const OUTPUT_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const RUN_NOT_FOUND = 'Run not found';

export const launchSchema = z.object({
  prompt: z.string().trim().min(1, 'Describe the task').max(MAX_PROMPT_LENGTH),
  templateId: z.string().min(1),
  /** One account per tool of the template when the member has several; else picked for them. */
  accountIds: z.array(z.string().min(1)).max(MAX_ACCOUNTS).default([]),
  harness: z.enum(HARNESSES),
  model: z.string().trim().min(1).max(MAX_MODEL_LENGTH).optional(),
});
export type LaunchInput = z.infer<typeof launchSchema>;

export interface LaunchOptions {
  scheduleId?: string;
  triggerId?: string;
  /** A trigger's instructions, added to the system prompt. */
  instructions?: string;
  memoryIn?: string | null;
  /** The schedule's recorded member key generation: the run fails if it changed. */
  keyGeneration?: number;
}

export type Actor = { kind: 'admin' } | { kind: 'member'; member: Member };

/** A validated launch: what the run will use. */
export interface LaunchPlan {
  prompt: string;
  harness: Harness;
  model: string | null;
  template: Template;
  accountIds: string[];
  timeoutSeconds: number;
  tokenBudget: number;
}

export interface LaunchpadDeps {
  gateway: Gateway;
  runs: RunStore;
  driver: VmDriver;
  crypto: CryptoBox;
  /** Gateway base URL as seen from inside the VMs. */
  vmGatewayUrl: string;
  now?: () => Date;
}

/** Which model API a template gives a harness, and the model to use by default. */
export interface HarnessChoice {
  harness: Harness;
  provider: LlmProvider;
  /** Exact models in the template's allowlist (empty = any model). */
  models: string[];
  /**
   * The harness has no default model for this API (custom endpoints): the launch must name one
   * when `models` is empty.
   */
  modelRequired: boolean;
}

/** What `harnessChoices` reads of a grant (stored, session or public grants all fit). */
type ChoiceGrant = Pick<ToolGrant, 'tool' | 'permissions' | 'resources'> & {
  endpoint?: { api: LlmEndpointApi };
};

/** Whether a grant gives a harness this model API: calls allowed, and a chat API it speaks. */
function grantServes(harness: Harness, provider: LlmProvider, grant: ChoiceGrant): boolean {
  if (grant.tool !== provider || !grant.permissions.includes('llm:invoke')) return false;
  if (provider !== CUSTOM_PROVIDER) return true;
  return (
    grant.endpoint !== undefined && HARNESS_ENDPOINT_APIS[harness].includes(grant.endpoint.api)
  );
}

/** The model API grant a harness uses among these, in its order of preference. */
function harnessGrant<G extends ChoiceGrant>(
  harness: Harness,
  grants: readonly G[],
): G | undefined {
  for (const provider of HARNESS_PROVIDERS[harness]) {
    const grant = grants.find((g) => grantServes(harness, provider, g));
    if (grant) return grant;
  }
  return undefined;
}

/**
 * The agent launchpad: queues runs, issues each one a session key, boots its VM, takes the
 * runner's reports and always cleans up (key revoked, VM destroyed) when a run ends.
 */
export class Launchpad {
  private readonly now: () => Date;
  private pumping: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private readonly finishedListeners: ((run: Run) => void)[] = [];

  constructor(private readonly deps: LaunchpadDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Called after a run reached a final state (the scheduler keeps memory from it). */
  onFinished(listener: (run: Run) => void): void {
    this.finishedListeners.push(listener);
  }

  get runs(): RunStore {
    return this.deps.runs;
  }

  get driverName(): string {
    return this.deps.driver.name;
  }

  // ---------------------------------------------------------------- launching

  /** Harnesses a template can run, given the model APIs it grants. */
  harnessChoices(template: { grants: readonly ChoiceGrant[] }): HarnessChoice[] {
    return HARNESSES.flatMap((harness) => {
      const grant = harnessGrant(harness, template.grants);
      if (!grant) return [];
      const provider = grant.tool as LlmProvider;
      return [
        {
          harness,
          provider,
          models: grant.resources.filter((r) => !r.includes('*')),
          modelRequired: provider === CUSTOM_PROVIDER,
        },
      ];
    });
  }

  /**
   * Checks that the member may launch this agent now (launch rights, template, accounts, model
   * access for the harness, a key TTL long enough) and resolves what the run will use.
   */
  plan(member: Member, input: unknown): LaunchPlan {
    const req = launchSchema.parse(input);
    const settings = this.deps.runs.settings();
    if (!this.deps.runs.memberLaunch(member.id).launchEnabled) {
      throw forbidden('Launching agents is disabled for you');
    }
    const plan = this.deps.gateway.planMemberSession(
      member,
      req.templateId,
      req.accountIds,
      runToolScope(req.harness),
    );
    const needs = HARNESS_PROVIDERS[req.harness].join(' or ');
    if (!this.harnessChoices(plan.template).some((c) => c.harness === req.harness)) {
      throw badRequest(
        `Template "${plan.template.name}" gives no ${needs} access, which ${req.harness} needs`,
      );
    }
    // The model API the run uses: one the template grants and the member has an account for.
    const covered = plan.template.grants.filter((g) => plan.tools.includes(g.tool));
    const choice = this.harnessChoices({ grants: covered }).find((c) => c.harness === req.harness);
    if (!choice) {
      // Custom endpoints need no account: only the official APIs the template grants can be missing.
      const missing = HARNESS_PROVIDERS[req.harness].filter((p) =>
        plan.template.grants.some((g) => grantServes(req.harness, p, g)),
      );
      throw badRequest(`No ${missing.join(' or ')} account available`);
    }
    const timeoutSeconds = Math.min(
      settings.defaultTimeoutSeconds,
      settings.maxTimeoutSeconds,
      plan.template.maxTtlSeconds - KEY_MARGIN_SECONDS,
    );
    if (timeoutSeconds < MIN_RUN_SECONDS) {
      throw badRequest(
        `Template "${plan.template.name}" keys last too little for an agent run (max TTL ${plan.template.maxTtlSeconds}s)`,
      );
    }
    return {
      prompt: req.prompt,
      harness: req.harness,
      model: this.pickModel(plan.template, choice, req.model),
      template: plan.template,
      accountIds: plan.accountIds,
      timeoutSeconds,
      tokenBudget: settings.tokenBudgetPerRun,
    };
  }

  launch(member: Member, input: unknown, opts: LaunchOptions = {}): Run {
    const plan = this.plan(member, input);
    const run = this.deps.runs.insert({
      id: randomId(),
      memberId: member.id,
      memberName: member.name,
      scheduleId: opts.scheduleId ?? null,
      triggerId: opts.triggerId ?? null,
      harness: plan.harness,
      model: plan.model,
      prompt: plan.prompt,
      instructions: opts.instructions ?? null,
      templateId: plan.template.id,
      templateName: plan.template.name,
      accountIds: plan.accountIds,
      timeoutSeconds: plan.timeoutSeconds,
      tokenBudget: plan.tokenBudget,
      keyGeneration: opts.keyGeneration ?? null,
      memoryIn: opts.memoryIn ?? null,
      createdAt: this.now().toISOString(),
    });
    this.log(run, `${launchedBy(member, opts)} a ${plan.harness} agent`);
    void this.pump();
    return this.deps.runs.require(run.id);
  }

  private pickModel(template: Template, choice: HarnessChoice, requested?: string): string | null {
    if (requested === undefined) {
      const model = choice.models[0] ?? null;
      if (model === null && choice.modelRequired) {
        throw badRequest(
          `Template "${template.name}" gives a custom LLM endpoint: name the model to use`,
        );
      }
      return model;
    }
    const grant = template.grants.find((g) => g.tool === choice.provider);
    if (!grant || !modelAllowed(grant, requested)) {
      throw badRequest(`Model "${requested}" is not allowed by template "${template.name}"`);
    }
    return requested;
  }

  /** Starts queued runs while there is capacity. Serialized: one pump at a time. */
  pump(): Promise<void> {
    this.pumping = this.pumping
      .then(() => this.pumpOnce())
      .catch((err: unknown) => {
        console.error('Launchpad: failed to start queued runs', err);
      });
    return this.pumping;
  }

  private async pumpOnce(): Promise<void> {
    const settings = this.deps.runs.settings();
    for (const run of this.deps.runs.withStatus(['queued'])) {
      if (this.deps.runs.countActive() >= settings.maxConcurrentRuns) return;
      const perMember =
        this.deps.runs.memberLaunch(run.memberId).maxConcurrent ?? settings.maxConcurrentPerMember;
      if (this.deps.runs.countActive(run.memberId) >= perMember) continue;
      await this.start(run);
    }
  }

  private async start(queued: Run): Promise<void> {
    const startedAt = this.now();
    // The runner's token exists from here on, and only its hash is stored.
    const runToken = randomToken(RUN_TOKEN_PREFIX);
    const moved = this.deps.runs.transition(queued.id, ['queued'], 'provisioning', {
      startedAt: startedAt.toISOString(),
      runTokenHash: this.deps.crypto.hashToken(runToken),
    });
    if (!moved) return;
    try {
      const config = await this.prepare(queued, runToken, startedAt);
      const settings = this.deps.runs.settings();
      const killAt = new Date(Date.parse(config.deadline) + KILL_GRACE_SECONDS * MS_PER_SECOND);
      const { vmId } = await this.deps.driver.create({
        runId: queued.id,
        config,
        vcpus: settings.vcpus,
        memMib: settings.memMib,
        killAt: killAt.toISOString(),
      });
      const running = this.deps.runs.transition(queued.id, ['provisioning'], 'running', {
        vmId,
        deadline: config.deadline,
      });
      // Cancelled while booting: the VM must not outlive its run.
      if (!running) await this.deps.driver.destroy(vmId).catch(() => undefined);
    } catch (err) {
      await this.finish(queued.id, 'failed', { statusReason: reasonOf(err) });
    }
  }

  /** Issues the run's session key and builds the runner configuration. */
  private async prepare(
    run: Run,
    runToken: string,
    startedAt: Date,
  ): Promise<Omit<RunnerConfig, 'network'>> {
    const { key, session } = await this.deps.gateway.issueSessionForRun(
      run.memberId,
      run.id,
      {
        templateId: run.templateId,
        accountIds: run.accountIds,
        ttlSeconds: run.timeoutSeconds + KEY_MARGIN_SECONDS,
        label: `agent run ${run.id}`,
        tokenBudget: run.tokenBudget ?? undefined,
      },
      run.keyGeneration ?? undefined,
      runToolScope(run.harness),
    );
    this.deps.runs.update(run.id, { sessionId: session.id });
    const deadline = new Date(
      startedAt.getTime() + run.timeoutSeconds * MS_PER_SECOND,
    ).toISOString();
    const catalog = this.deps.gateway.toolCatalog();
    const grants: PromptGrant[] = session.grants.flatMap((g) => {
      const entry = catalog.find((t) => t.id === g.tool);
      if (!entry || entry.kind === 'llm') return [];
      return [
        {
          tool: g.tool,
          name: entry.name,
          permissions: entry.permissions.filter((p) => g.permissions.includes(p.id)),
          resources: g.resources,
          resourceHelp: entry.resourceHelp,
        },
      ];
    });
    const llm = harnessGrant(run.harness, session.grants);
    if (!llm) throw new Error(`The session key gives no model access for ${run.harness}`);
    const api = llm.endpoint?.api;
    if (api && run.model === null) throw new Error('No model set for the custom LLM endpoint');
    return {
      runId: run.id,
      runToken,
      gatewayUrl: this.deps.vmGatewayUrl,
      sessionKey: key,
      harness: run.harness,
      llm: { provider: llm.tool as LlmProvider, model: run.model, ...(api && { api }) },
      gatewayTools: grants.map((g) => gatewayToolName(g.tool)),
      egressDomains: session.egressDomains ?? [],
      prompt: run.prompt,
      systemPrompt: buildSystemPrompt({
        harness: run.harness,
        grants,
        egressDomains: session.egressDomains ?? [],
        deadline,
        hasMemory: run.memoryIn !== null,
        instructions: run.instructions,
      }),
      memory: run.memoryIn,
      deadline,
    };
  }

  // ---------------------------------------------------------------- runner reports

  /** The active run a runner token belongs to. */
  runnerRun(token: string | null): Run {
    if (!token?.startsWith(RUN_TOKEN_PREFIX)) throw unauthorized('Run token required');
    const run = this.deps.runs.byTokenHash(this.deps.crypto.hashToken(token));
    if (!run) throw unauthorized('Unknown or finished run');
    return run;
  }

  reportEvents(run: Run, events: readonly RunEvent[]): number {
    if (events.length > RUNNER_LIMITS.batchEvents) throw badRequest('Too many events in one batch');
    return this.deps.runs.appendEvents(run.id, events);
  }

  reportOutput(run: Run, path: string, content: Buffer): void {
    if (
      path.length > MAX_OUTPUT_PATH ||
      !OUTPUT_PATH_RE.test(path) ||
      path.split('/').some((s) => s === '.' || s === '..')
    ) {
      throw badRequest('Invalid output path');
    }
    if (content.length > RUNNER_LIMITS.outputFileBytes) throw badRequest('Output file too large');
    const fresh = this.deps.runs.output(run.id, path) === null;
    if (fresh && this.deps.runs.outputCount(run.id) >= RUNNER_LIMITS.outputFiles) {
      throw badRequest('Too many output files');
    }
    if (run.outputsBytes + content.length > RUNNER_LIMITS.outputTotalBytes) {
      throw badRequest('Output files exceed the run total');
    }
    const now = this.now();
    const days = this.deps.runs.settings().outputRetentionDays;
    const expiresAt = new Date(now.getTime() + days * MS_PER_DAY).toISOString();
    this.deps.runs.putOutput(run.id, path, content, now.toISOString(), expiresAt);
  }

  async reportFinish(run: Run, body: RunnerFinishBody): Promise<Run> {
    await this.finish(run.id, body.outcome, {
      finalMessage:
        body.finalMessage === null ? null : clip(body.finalMessage, RUNNER_LIMITS.finalMessage),
      memoryOut: body.memory === null ? null : clip(body.memory, RUNNER_LIMITS.memory),
      statusReason: body.error,
    });
    return this.deps.runs.require(run.id);
  }

  // ---------------------------------------------------------------- viewing & stopping

  /** A run the actor may see: members only their own (others look like they don't exist). */
  visibleRun(actor: Actor, runId: string): Run {
    const run = this.deps.runs.get(runId);
    if (!run || (actor.kind === 'member' && run.memberId !== actor.member.id)) {
      throw notFound(RUN_NOT_FOUND);
    }
    return run;
  }

  async cancel(actor: Actor, runId: string): Promise<Run> {
    const run = this.visibleRun(actor, runId);
    if (!isActive(run.status)) throw conflict(`Run already ${run.status}`);
    const by = actor.kind === 'admin' ? 'the admin' : `member "${actor.member.name}"`;
    await this.finish(run.id, 'cancelled', { statusReason: `Stopped by ${by}` });
    return this.deps.runs.require(run.id);
  }

  /**
   * Moves an active run to a final state, then revokes its key and destroys its VM. Safe to call
   * twice: only the first call to win the transition cleans up.
   */
  private async finish(runId: string, status: RunStatus, patch: RunPatch): Promise<void> {
    const finishedAt = this.now().toISOString();
    if (!this.deps.runs.transition(runId, ACTIVE_STATUSES, status, { ...patch, finishedAt }))
      return;
    const run = this.deps.runs.require(runId);
    await this.cleanup(run);
    const reason = run.statusReason ? `: ${run.statusReason}` : '';
    this.log(run, `Run ${status}${reason}`);
    for (const listener of this.finishedListeners) {
      try {
        listener(run);
      } catch (err) {
        console.error('Launchpad: onFinished listener failed', err);
      }
    }
    void this.pump();
  }

  private async cleanup(run: Run): Promise<void> {
    if (run.sessionId) {
      const issuer: SessionIssuer = {
        kind: 'launchpad',
        memberId: run.memberId,
        memberName: run.memberName,
        runId: run.id,
      };
      await this.deps.gateway.revokeSession(run.sessionId, issuer).catch(() => undefined);
    }
    if (run.vmId) {
      await this.deps.driver.destroy(run.vmId).catch((err: unknown) => {
        console.error(`Launchpad: could not destroy VM ${run.vmId ?? ''}`, err);
      });
    }
  }

  // ---------------------------------------------------------------- housekeeping

  /** Fails runs left mid-provisioning by a restart; their VMs are reaped by `reap`. */
  async recover(): Promise<void> {
    for (const run of this.deps.runs.withStatus(['provisioning'])) {
      await this.finish(run.id, 'failed', {
        statusReason: 'The gateway restarted while the run was starting',
      });
    }
    await this.reap();
  }

  /**
   * Enforces deadlines, fails runs whose VM died without reporting, destroys VMs no active run
   * owns and deletes expired output files. Runs every minute.
   */
  async reap(): Promise<void> {
    const now = this.now().getTime();
    const vms = await this.deps.driver.list().catch((err: unknown) => {
      console.error('Launchpad: could not list VMs', err);
      return null;
    });
    for (const run of this.deps.runs.withStatus(['provisioning', 'running'])) {
      await this.reapRun(run, now, vms);
    }
    if (vms) {
      // By run, not VM id: a run only learns its VM id once the boot returns.
      const active = new Set(this.deps.runs.withStatus(ACTIVE_STATUSES).map((r) => r.id));
      for (const vm of vms.filter((v) => !active.has(v.runId))) {
        await this.deps.driver.destroy(vm.vmId).catch(() => undefined);
      }
    }
    this.deps.runs.purgeExpiredOutputs(new Date(now).toISOString());
    void this.pump();
  }

  private async reapRun(
    run: Run,
    now: number,
    vms: Awaited<ReturnType<VmDriver['list']>> | null,
  ): Promise<void> {
    if (run.status === 'provisioning') {
      if (run.startedAt && now - Date.parse(run.startedAt) > PROVISION_TIMEOUT_MS) {
        await this.finish(run.id, 'failed', { statusReason: 'The VM took too long to start' });
      }
      return;
    }
    if (run.deadline && now > Date.parse(run.deadline) + KILL_GRACE_SECONDS * MS_PER_SECOND) {
      await this.finish(run.id, 'timed_out', { statusReason: 'The agent exceeded its time limit' });
      return;
    }
    if (!vms || !run.vmId) return;
    const vm = vms.find((v) => v.vmId === run.vmId);
    const startedLongEnough =
      run.startedAt !== null && now - Date.parse(run.startedAt) > EXIT_REPORT_GRACE_MS;
    if (!vm?.running && startedLongEnough) {
      await this.finish(run.id, 'failed', {
        statusReason: 'The VM stopped before the agent reported a result',
      });
    }
  }

  startTimers(intervalMs: number): void {
    this.timer = setInterval(() => {
      this.reap().catch((err: unknown) => {
        console.error('Launchpad: reap failed', err);
      });
    }, intervalMs);
    this.timer.unref();
  }

  stopTimers(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private log(run: Run, detail: string): void {
    this.deps.gateway.activity.add({
      kind: 'launchpad',
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      detail: `${detail} (run ${run.id})`,
    });
  }
}

/**
 * What a run's key covers: the model APIs the harness can't use (custom endpoints speaking
 * another chat API included) are left out; when the harness can use several, those without an
 * account are too.
 */
function runToolScope(harness: Harness): RunToolScope {
  const providers: readonly string[] = HARNESS_PROVIDERS[harness];
  return {
    drop: LLM_PROVIDERS.filter((p) => !providers.includes(p)),
    optional: providers.length > 1 ? providers : [],
    endpointApis: HARNESS_ENDPOINT_APIS[harness],
  };
}

function launchedBy(member: Member, opts: LaunchOptions): string {
  if (opts.scheduleId) return 'Schedule launched';
  if (opts.triggerId) return 'Webhook trigger launched';
  return `Member "${member.name}" launched`;
}

function reasonOf(err: unknown): string {
  if (err instanceof HttpError || err instanceof Error) return err.message;
  return String(err);
}
