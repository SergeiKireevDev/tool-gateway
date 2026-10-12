import { z } from 'zod';
import {
  badGateway,
  badRequest,
  conflict,
  forbidden,
  HttpError,
  notFound,
  unauthorized,
} from '../errors.js';
import type { Gateway, RunToolScope } from '../gateway.js';
import type { CryptoBox } from '../store/crypto.js';
import { randomId, randomToken } from '../store/crypto.js';
import type { Member, SessionIssuer, Template, ToolGrant } from '../store/types.js';
import { modelAllowed } from '../tools/llm/common.js';
import { listEndpointModels } from '../tools/llm/custom.js';
import type { LlmEndpointApi } from '../tools/types.js';
import { MS_PER_DAY, MS_PER_SECOND, SECONDS_PER_MINUTE } from '../units.js';
import {
  CUSTOM_PROVIDER,
  type Harness,
  HARNESS_ENDPOINT_APIS,
  HARNESS_PROVIDERS,
  HARNESSES,
  LLM_PROVIDERS,
  type LlmProvider,
  type RunHarness,
  RUN_TOKEN_PREFIX,
  type RunEvent,
  type RunInput,
  type RunnerConfig,
  type RunnerFinishBody,
  OUTPUT_CHUNK_BYTES,
  RUNNER_LIMITS,
  SCRIPT_HARNESS,
} from './protocol.js';
import {
  ACTIVE_STATUSES,
  clip,
  isActive,
  type Run,
  type RunPatch,
  type RunStatus,
  type RunStore,
  type Workflow,
  type WorkflowStep,
} from './runStore.js';
import { Environments } from './environments.js';
import { Skills } from './skills.js';
import { buildSystemPrompt, gatewayToolName, type PromptGrant } from './systemPrompt.js';
import type { VmDriver } from './vmDriver.js';
import { buildPlannerPrompt } from './workflowPrompt.js';

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
const MAX_ID_LENGTH = 100;
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
  /** A guest environment the admin added; the default guest image if unset. */
  environmentId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
});
export type LaunchInput = z.infer<typeof launchSchema>;

/** The execution step of a workflow: which template, accounts and endpoint model run the script. */
export interface ScriptInput {
  templateId: string;
  accountIds: string[];
  model: string | undefined;
}

/** A workflow's planning agent: an agent and a model API, on whichever template gives them. */
export interface PlannerInput {
  prompt: string;
  harness: Harness;
  /** The model API it uses; any the member's templates give the harness if unset. */
  provider: LlmProvider | undefined;
  model: string | undefined;
  /** The member's account for that model API, when they have several. */
  accountIds: string[];
}

export interface LaunchOptions {
  scheduleId?: string;
  triggerId?: string;
  /** A trigger's instructions, added to the system prompt. */
  instructions?: string;
  memoryIn?: string | null;
  /** The schedule's recorded member key generation: the run fails if it changed. */
  keyGeneration?: number;
  /** The workflow the run is a step of. */
  workflowId?: string;
  workflowStep?: WorkflowStep;
  /** A run of the member's whose output files the run starts from (chaining). */
  parentRunId?: string;
}

/** Extra fields of a launch now: the run to chain it after, if any. */
export const chainSchema = z.object({
  parentRunId: z.string().min(1).max(MAX_ID_LENGTH).optional(),
});

export type Actor = { kind: 'admin' } | { kind: 'member'; member: Member };

/** A validated launch: what the run will use. */
export interface LaunchPlan {
  prompt: string;
  harness: RunHarness;
  /** The model API the run uses (null: a script on a template without a custom endpoint). */
  provider: LlmProvider | null;
  model: string | null;
  template: Template;
  accountIds: string[];
  /** The guest environment the VM boots, or null for the default guest image. */
  environment: { id: string; name: string } | null;
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
  /** Reaches custom LLM endpoints, to list their models. */
  fetchImpl?: typeof fetch;
}

/** Which model API a template gives a harness, and the model to use by default. */
export interface HarnessChoice {
  harness: RunHarness;
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
function grantServes(harness: RunHarness, provider: LlmProvider, grant: ChoiceGrant): boolean {
  if (grant.tool !== provider || !grant.permissions.includes('llm:invoke')) return false;
  if (provider !== CUSTOM_PROVIDER) return true;
  return (
    grant.endpoint !== undefined && HARNESS_ENDPOINT_APIS[harness].includes(grant.endpoint.api)
  );
}

/** The model API grant a harness uses among these, in its order of preference. */
function harnessGrant<G extends ChoiceGrant>(
  harness: RunHarness,
  grants: readonly G[],
): G | undefined {
  for (const provider of HARNESS_PROVIDERS[harness]) {
    const grant = grants.find((g) => grantServes(harness, provider, g));
    if (grant) return grant;
  }
  return undefined;
}

/** What a template gives a harness: the model API it would use, and its models. */
function harnessChoice(
  harness: RunHarness,
  grants: readonly ChoiceGrant[],
): HarnessChoice | undefined {
  const grant = harnessGrant(harness, grants);
  if (!grant) return undefined;
  const provider = grant.tool as LlmProvider;
  return {
    harness,
    provider,
    models: grant.resources.filter((r) => !r.includes('*')),
    modelRequired: provider === CUSTOM_PROVIDER,
  };
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
  /** The guest environments the admin added, which runs can boot. */
  readonly environments: Environments;
  /** The skill library: what agents learned during their runs, kept per member. */
  readonly skills: Skills;

  constructor(private readonly deps: LaunchpadDeps) {
    this.now = deps.now ?? (() => new Date());
    this.environments = new Environments(deps.runs.db, deps.driver, this.now);
    this.skills = new Skills(deps.runs.db, this.now);
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
      const choice = harnessChoice(harness, template.grants);
      return choice ? [choice] : [];
    });
  }

  /**
   * The custom LLM endpoint a template gives a workflow's script, or null: any template runs a
   * script, which then only has the template's tools. The planning agent doesn't depend on it.
   */
  workflowChoice(template: { grants: readonly ChoiceGrant[] }): {
    executor: HarnessChoice | null;
  } {
    return { executor: harnessChoice(SCRIPT_HARNESS, template.grants) ?? null };
  }

  /**
   * The planning agents a member can pick for a workflow: every agent and model API their
   * templates give, whatever the template (a planner gets none of its tools). Custom endpoints
   * add the models they list.
   */
  async plannerChoices(member: Member): Promise<HarnessChoice[]> {
    const choices = new Map<string, HarnessChoice>();
    for (const template of this.deps.gateway.memberView(member).templates) {
      for (const choice of this.harnessChoices(template)) {
        const listed =
          choice.provider === CUSTOM_PROVIDER
            ? await this.endpointModels(member, template.id).catch(() => [])
            : [];
        const key = `${choice.harness}:${choice.provider}`;
        const known = choices.get(key);
        choices.set(key, {
          ...choice,
          models: [...new Set([...(known?.models ?? []), ...choice.models, ...listed])],
          modelRequired: choice.modelRequired && (known?.modelRequired ?? true),
        });
      }
    }
    return [...choices.values()];
  }

  /**
   * The models a template's custom LLM endpoint serves that the template's allowlist covers, for
   * the member to pick from when launching an agent. Asked from the endpoint itself.
   */
  async endpointModels(member: Member, templateId: string): Promise<string[]> {
    if (!this.deps.runs.memberLaunch(member.id).launchEnabled) {
      throw forbidden('Launching agents is disabled for you');
    }
    const template = this.deps.gateway.memberTemplate(member, templateId);
    const grant = template.grants.find(
      (g) => g.tool === CUSTOM_PROVIDER && g.permissions.includes('llm:invoke'),
    );
    if (!grant?.endpoint) {
      throw badRequest(`Template "${template.name}" gives no custom LLM endpoint`);
    }
    let models: string[];
    try {
      models = await listEndpointModels(grant.endpoint, this.deps.fetchImpl);
    } catch (err) {
      throw badGateway((err as Error).message);
    }
    return models.filter((m) => modelAllowed(grant, m));
  }

  /**
   * Checks that the member may launch this agent now (launch rights, template, accounts, model
   * access for the harness, a key TTL long enough) and resolves what the run will use.
   */
  plan(member: Member, input: unknown, step?: WorkflowStep): LaunchPlan {
    const req = launchSchema.parse(input);
    return this.resolve(member, req, this.toolScope(req.harness, step ?? null));
  }

  /**
   * Checks a workflow's planning agent like a launch, on the first of the member's templates that
   * gives this agent the model API (`provider`, else any) and the model. No permission template is
   * picked by the member: the planner gets none of the template's tools, only its model API.
   */
  planPlanner(member: Member, input: PlannerInput): LaunchPlan {
    const candidates = this.deps.gateway.memberView(member).templates.filter((t) => {
      const choice = harnessChoice(input.harness, t.grants);
      return choice && (input.provider === undefined || choice.provider === input.provider);
    });
    const errors: Error[] = [];
    for (const template of candidates) {
      try {
        const plan = this.plan(member, { ...input, templateId: template.id }, 'plan');
        // Without an account for the requested API, the agent may fall back on another one.
        if (input.provider === undefined || plan.provider === input.provider) return plan;
        errors.push(badRequest(`No ${input.provider} account available`));
      } catch (err) {
        errors.push(err as Error);
      }
    }
    if (errors[0] !== undefined) throw errors[0];
    const api = input.provider ? `${input.provider} access` : 'model access';
    throw badRequest(`None of your templates gives ${input.harness} ${api}`);
  }

  /**
   * Checks the execution step of a workflow like a launch. Any template runs a script: when it
   * gives a custom LLM endpoint, the script gets it, with a model to use on it.
   */
  planScript(member: Member, input: ScriptInput, script: string): LaunchPlan {
    return this.resolve(
      member,
      { ...input, prompt: script, harness: SCRIPT_HARNESS },
      this.toolScope(SCRIPT_HARNESS, 'execute'),
    );
  }

  private resolve(
    member: Member,
    req: Omit<LaunchInput, 'harness'> & { harness: RunHarness },
    scope: RunToolScope,
  ): LaunchPlan {
    const settings = this.deps.runs.settings();
    if (!this.deps.runs.memberLaunch(member.id).launchEnabled) {
      throw forbidden('Launching agents is disabled for you');
    }
    const plan = this.deps.gateway.planMemberSession(member, req.templateId, req.accountIds, scope);
    const script = req.harness === SCRIPT_HARNESS;
    if (!script && !harnessChoice(req.harness, plan.template.grants)) {
      const needs = HARNESS_PROVIDERS[req.harness].join(' or ');
      throw badRequest(
        `Template "${plan.template.name}" gives no ${needs} access, which ${req.harness} needs`,
      );
    }
    // The model API the run uses: one the template grants and the member has an account for.
    const covered = plan.template.grants.filter((g) => plan.tools.includes(g.tool));
    const choice = harnessChoice(req.harness, covered);
    if (!choice && script && req.model !== undefined) {
      throw badRequest(
        `Template "${plan.template.name}" gives no custom LLM endpoint for the script's model`,
      );
    }
    if (!choice && !script) {
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
      provider: choice?.provider ?? null,
      model: choice ? this.pickModel(plan.template, choice, req.model) : null,
      template: plan.template,
      accountIds: plan.accountIds,
      environment: this.environment(req.environmentId),
      timeoutSeconds,
      tokenBudget: settings.tokenBudgetPerRun,
    };
  }

  /** The guest environment a launch asks for, if any: one the admin enabled, and built. */
  private environment(id: string | undefined): LaunchPlan['environment'] {
    if (id === undefined) return null;
    const { name } = this.environments.launchable(id);
    return { id, name };
  }

  launch(member: Member, input: unknown, opts: LaunchOptions = {}): Run {
    const plan = this.plan(member, input, opts.workflowStep);
    if (opts.parentRunId !== undefined) this.chainParent(member, opts.parentRunId);
    return this.launchPlan(member, plan, opts);
  }

  /**
   * The run a launch is chained after: one of the member's own runs, finished, that left output
   * files (the new run starts from them).
   */
  private chainParent(member: Member, parentRunId: string): Run {
    const parent = this.visibleRun({ kind: 'member', member }, parentRunId);
    if (isActive(parent.status)) throw conflict('The run to chain after has not finished yet');
    if (this.deps.runs.outputCount(parent.id) === 0) {
      throw badRequest('The run to chain after left no output files');
    }
    return parent;
  }

  /** Queues a run checked by `plan` or `planScript`. */
  launchPlan(member: Member, plan: LaunchPlan, opts: LaunchOptions = {}): Run {
    const run = this.deps.runs.insert({
      id: randomId(),
      memberId: member.id,
      memberName: member.name,
      scheduleId: opts.scheduleId ?? null,
      triggerId: opts.triggerId ?? null,
      workflowId: opts.workflowId ?? null,
      workflowStep: opts.workflowStep ?? null,
      parentRunId: opts.parentRunId ?? null,
      harness: plan.harness,
      model: plan.model,
      prompt: plan.prompt,
      instructions: opts.instructions ?? null,
      templateId: plan.template.id,
      templateName: plan.template.name,
      accountIds: plan.accountIds,
      environmentId: plan.environment?.id ?? null,
      environmentName: plan.environment?.name ?? null,
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
      // The environment may have been disabled, deleted or rebuilt since the launch.
      if (queued.environmentId !== null) this.environments.launchable(queued.environmentId);
      const config = await this.prepare(queued, runToken, startedAt);
      const settings = this.deps.runs.settings();
      const killAt = new Date(Date.parse(config.deadline) + KILL_GRACE_SECONDS * MS_PER_SECOND);
      const { vmId } = await this.deps.driver.create({
        runId: queued.id,
        config,
        vcpus: settings.vcpus,
        memMib: settings.memMib,
        killAt: killAt.toISOString(),
        ...(queued.environmentId === null ? {} : { imageId: queued.environmentId }),
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
      this.toolScope(run.harness, run.workflowStep),
    );
    this.deps.runs.update(run.id, { sessionId: session.id });
    const deadline = new Date(
      startedAt.getTime() + run.timeoutSeconds * MS_PER_SECOND,
    ).toISOString();
    const grants = this.promptGrants(session.grants);
    // A chained run gets the output files its parent still has (they expire).
    const inputs =
      run.parentRunId === null
        ? undefined
        : this.deps.runs.outputs(run.parentRunId).map(({ path, size }) => ({ path, size }));
    return {
      runId: run.id,
      runToken,
      gatewayUrl: this.deps.vmGatewayUrl,
      sessionKey: key,
      harness: run.harness,
      llm: runLlm(run, session.grants),
      gatewayTools: grants.map((g) => gatewayToolName(g.tool)),
      egressDomains: session.egressDomains ?? [],
      prompt: run.prompt,
      systemPrompt: this.systemPrompt(run, grants, session.egressDomains ?? [], deadline, inputs),
      ...(inputs && { inputs }),
      memory: run.memoryIn,
      deadline,
    };
  }

  /** What the run's agent is told: the usual agent prompt, or a workflow planner's. */
  private systemPrompt(
    run: Run,
    grants: PromptGrant[],
    egressDomains: string[],
    deadline: string,
    inputs: RunInput[] | undefined,
  ): string {
    if (run.harness === SCRIPT_HARNESS) return '';
    if (run.workflowStep !== 'plan') {
      return buildSystemPrompt({
        harness: run.harness,
        grants,
        egressDomains,
        deadline,
        hasMemory: run.memoryIn !== null,
        instructions: run.instructions,
        chain:
          run.parentRunId === null ? null : { parentRunId: run.parentRunId, files: inputs ?? [] },
      });
    }
    const workflow = this.deps.runs.requireWorkflow(run.workflowId ?? '');
    const { grants: tools, api } = this.executorView(run.memberId, workflow);
    return buildPlannerPrompt({
      grants: tools,
      llm: api && workflow.executorModel ? { api, model: workflow.executorModel } : null,
      egressDomains,
      deadline,
    });
  }

  /** What a workflow's script will have (its tools, its endpoint's chat API), for its planner. */
  private executorView(
    memberId: string,
    workflow: Workflow,
  ): { grants: PromptGrant[]; api: LlmEndpointApi | null } {
    const member = this.deps.gateway.activeMember(memberId);
    if (!member) throw new Error('The member is gone or expired');
    const plan = this.deps.gateway.planMemberSession(
      member,
      workflow.templateId,
      workflow.accountIds,
      this.toolScope(SCRIPT_HARNESS, 'execute'),
    );
    const covered = plan.template.grants.filter((g) => plan.tools.includes(g.tool));
    const endpoint = harnessGrant(SCRIPT_HARNESS, covered)?.endpoint;
    if (workflow.executorModel !== null && !endpoint) {
      throw new Error('The template no longer gives a custom LLM endpoint');
    }
    return { grants: this.promptGrants(covered), api: endpoint?.api ?? null };
  }

  /** Tool grants as the prompts describe them (LLM providers left out). */
  private promptGrants(grants: readonly Pick<ToolGrant, 'tool' | 'permissions' | 'resources'>[]) {
    const catalog = this.deps.gateway.toolCatalog();
    return grants.flatMap((g): PromptGrant[] => {
      const entry = catalog.find((t) => t.id === g.tool);
      if (!entry || entry.kind === 'llm') return [];
      return [
        {
          tool: g.tool,
          name: entry.name,
          permissions: entry.permissions.filter((p) => g.permissions.includes(p.id)),
          resources: g.resources,
          resourceHelp: entry.resourceHelp,
          example: entry.example,
        },
      ];
    });
  }

  /**
   * What a run's key covers. A workflow's planner gets no third-party tool at all: it writes the
   * script from the tools' description, and never sees the data the script handles.
   */
  private toolScope(harness: RunHarness, step: WorkflowStep | null): RunToolScope {
    const scope = runToolScope(harness);
    if (step !== 'plan') return scope;
    const tools = this.deps.gateway
      .toolCatalog()
      .filter((t) => t.kind !== 'llm')
      .map((t) => t.id);
    return { ...scope, drop: [...scope.drop, ...tools] };
  }

  // ---------------------------------------------------------------- runner reports

  /** The active run a runner token belongs to. */
  runnerRun(token: string | null): Run {
    if (!token?.startsWith(RUN_TOKEN_PREFIX)) throw unauthorized('Run token required');
    const run = this.deps.runs.byTokenHash(this.deps.crypto.hashToken(token));
    if (!run) throw unauthorized('Unknown or finished run');
    return run;
  }

  /** An input file of a chained run: an output file of its parent, streamed to the runner. */
  runnerInput(run: Run, path: string): { size: number; chunks: Iterable<Buffer> } {
    const file =
      run.parentRunId === null ? null : this.deps.runs.outputStream(run.parentRunId, path);
    if (!file) throw notFound('Input file not found');
    return file;
  }

  reportEvents(run: Run, events: readonly RunEvent[]): number {
    if (events.length > RUNNER_LIMITS.batchEvents) throw badRequest('Too many events in one batch');
    return this.deps.runs.appendEvents(run.id, events);
  }

  /**
   * Stores an output file the runner uploads, streamed chunk by chunk into the database so a file
   * of up to 1 GiB is never held in memory whole. It replaces any earlier file at that path only
   * once it is complete.
   */
  async reportOutput(
    run: Run,
    path: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void> {
    if (
      path.length > MAX_OUTPUT_PATH ||
      !OUTPUT_PATH_RE.test(path) ||
      path.split('/').some((s) => s === '.' || s === '..')
    ) {
      throw badRequest('Invalid output path');
    }
    const fresh = this.deps.runs.outputStream(run.id, path) === null;
    if (fresh && this.deps.runs.outputCount(run.id) >= RUNNER_LIMITS.outputFiles) {
      throw badRequest('Too many output files');
    }
    const upload = { id: randomId(), size: 0 };
    try {
      await this.storeChunks(run, upload, content);
      const now = this.now();
      const days = this.deps.runs.settings().outputRetentionDays;
      const expiresAt = new Date(now.getTime() + days * MS_PER_DAY).toISOString();
      this.deps.runs.commitOutput(run.id, path, upload, now.toISOString(), expiresAt);
    } catch (err) {
      this.deps.runs.discardUpload(upload.id);
      throw err;
    }
  }

  private async storeChunks(
    run: Run,
    upload: { id: string; size: number },
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void> {
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let seq = 0;
    const flush = (): void => {
      if (pendingBytes === 0) return;
      this.deps.runs.putOutputChunk(run.id, upload.id, seq, Buffer.concat(pending));
      seq += 1;
      pending.length = 0;
      pendingBytes = 0;
    };
    for await (const piece of content) {
      upload.size += piece.length;
      if (upload.size > RUNNER_LIMITS.outputFileBytes) throw badRequest('Output file too large');
      if (run.outputsBytes + upload.size > RUNNER_LIMITS.outputTotalBytes) {
        throw badRequest('Output files exceed the run total');
      }
      pending.push(piece);
      pendingBytes += piece.length;
      if (pendingBytes >= OUTPUT_CHUNK_BYTES) flush();
    }
    flush();
  }

  async reportFinish(run: Run, body: RunnerFinishBody): Promise<Run> {
    // Kept whatever the outcome: what a failed run learned helps the next one.
    const skills = isActive(run.status) ? this.skills.saveFromRun(run, body.skills ?? []) : 0;
    if (skills > 0) this.log(run, `Exported ${skills} skill(s) to the skill library`);
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
    await this.environments.refresh().catch((err: unknown) => {
      console.error('Launchpad: could not check guest environment builds', err);
    });
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
 * The model API and model a run's harness uses, from its key's grants. Only a script may have
 * none: its template gave no custom LLM endpoint.
 */
function runLlm(run: Run, grants: readonly ChoiceGrant[]): RunnerConfig['llm'] {
  const llm = harnessGrant(run.harness, grants);
  if (!llm) {
    if (run.harness === SCRIPT_HARNESS && run.model === null) return null;
    throw new Error(`The session key gives no model access for ${run.harness}`);
  }
  const api = llm.endpoint?.api;
  if (api && run.model === null) throw new Error('No model set for the custom LLM endpoint');
  return { provider: llm.tool as LlmProvider, model: run.model, ...(api && { api }) };
}

/**
 * What a run's key covers: the model APIs the harness can't use (custom endpoints speaking
 * another chat API included) are left out; when the harness can use several, those without an
 * account are too.
 */
function runToolScope(harness: RunHarness): RunToolScope {
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
  if (opts.workflowStep === 'execute') return 'Workflow launched';
  const chained = opts.parentRunId ? ` (chained after run ${opts.parentRunId})` : '';
  return `Member "${member.name}"${chained} launched`;
}

function reasonOf(err: unknown): string {
  if (err instanceof HttpError || err instanceof Error) return err.message;
  return String(err);
}
