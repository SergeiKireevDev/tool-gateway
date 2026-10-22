import express, { type Request, type Response, type Router } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { badRequest, notFound, unauthorized } from '../errors.js';
import type { Gateway } from '../gateway.js';
import { bearerToken } from '../http/auth.js';
import { created, h, param } from '../http/handlers.js';
import type { Member } from '../store/types.js';
import { SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from '../units.js';
import type { GuestEnvironment } from './environments.js';
import { ATTACHMENT_LIMITS } from './attachments.js';
import { type Actor, type Launchpad, launchNowSchema } from './launchpad.js';
import type { Schedule, Scheduler } from './scheduler.js';
import { MAX_MESSAGE_CHARS } from './conversations.js';
import { MAX_RECEIVE_WAIT_SECONDS, type Triggers } from './triggers.js';
import type { Workflows, WorkflowView } from './workflows.js';
import { RUN_HARNESSES, RUNNER_LIMITS, SKILL_NAME_RE } from './protocol.js';
import type { Skills } from './skills.js';
import { RUN_STATUSES, type LaunchSettings, type Run, type RunFilter } from './runStore.js';

const MAX_TIMEOUT_HOURS = 24;
const MIN_TIMEOUT_MINUTES = 5;
const MAX_TIMESTAMP_LENGTH = 40;
const MAX_ID_LENGTH = 200;
const MAX_CONCURRENT = 100;
const MAX_VCPUS = 16;
const MAX_MEM_MIB = 65_536;
const MIN_MEM_MIB = 256;
const MAX_RETENTION_DAYS = 3650;
const MAX_TOKEN_BUDGET = 1e10;
const RUN_ID = 'id';
const SCHEDULES_PATH = '/schedules';
const SCHEDULE_PATH = '/schedules/:sid';
const TRIGGERS_PATH = '/triggers';
const TRIGGER_PATH = '/triggers/:tid';
const CONVERSATIONS_PATH = `${TRIGGER_PATH}/conversations`;
const CONVERSATION_PATH = `${CONVERSATIONS_PATH}/:cid`;
const WORKFLOWS_PATH = '/workflows';
const WORKFLOW_PATH = '/workflows/:wid';
const ENVIRONMENTS_PATH = '/environments';
const ENVIRONMENT_PATH = '/environments/:eid';
const SKILLS_PATH = '/skills';
const SKILL_PATH = '/skills/:kid';
const ATTACHMENT_ID = 'aid';

const timeoutSeconds = z
  .number()
  .int()
  .min(MIN_TIMEOUT_MINUTES * SECONDS_PER_MINUTE)
  .max(MAX_TIMEOUT_HOURS * SECONDS_PER_HOUR);

const settingsSchema = z
  .object({
    maxConcurrentRuns: z.number().int().min(1).max(MAX_CONCURRENT),
    maxConcurrentPerMember: z.number().int().min(1).max(MAX_CONCURRENT),
    defaultTimeoutSeconds: timeoutSeconds,
    maxTimeoutSeconds: timeoutSeconds,
    tokenBudgetPerRun: z.number().int().min(1).max(MAX_TOKEN_BUDGET),
    vcpus: z.number().int().min(1).max(MAX_VCPUS),
    memMib: z.number().int().min(MIN_MEM_MIB).max(MAX_MEM_MIB),
    outputRetentionDays: z.number().int().min(1).max(MAX_RETENTION_DAYS),
  })
  .refine((s) => s.defaultTimeoutSeconds <= s.maxTimeoutSeconds, {
    message: 'The default timeout must not exceed the maximum',
    path: ['defaultTimeoutSeconds'],
  });

const uploadSchema = z.object({ name: z.string().min(1).max(MAX_ID_LENGTH) });
const partQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(ATTACHMENT_LIMITS.fileBytes),
});

const memberLaunchSchema = z.object({
  launchEnabled: z.boolean(),
  maxConcurrent: z.number().int().min(1).max(MAX_CONCURRENT).nullable(),
});

const eventSchema = z.object({
  seq: z.number().int().min(0),
  at: z.string().max(MAX_TIMESTAMP_LENGTH),
  type: z.enum([
    'status',
    'assistant_text',
    'thinking',
    'tool_call',
    'tool_result',
    'usage',
    'log',
    'error',
    'final',
  ]),
  text: z.string(),
  tool: z.string().max(MAX_ID_LENGTH).optional(),
  callId: z.string().max(MAX_ID_LENGTH).optional(),
  data: z.unknown().optional(),
});
const eventsSchema = z.object({ events: z.array(eventSchema).max(RUNNER_LIMITS.batchEvents) });
const finishSchema = z.object({
  outcome: z.enum(['succeeded', 'failed', 'timed_out']),
  finalMessage: z.string().nullable(),
  memory: z.string().nullable(),
  error: z.string().max(RUNNER_LIMITS.eventText).nullable(),
  skills: z
    .array(
      z.object({
        name: z.string().regex(SKILL_NAME_RE),
        content: z.string().max(RUNNER_LIMITS.skillContent),
      }),
    )
    .max(RUNNER_LIMITS.skills)
    .optional(),
});

const queryString = (req: Request, name: string): string | undefined => {
  const value = req.query[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

function runFilter(req: Request): RunFilter {
  const status = queryString(req, 'status');
  const harness = queryString(req, 'harness');
  const limit = queryString(req, 'limit');
  const filter: RunFilter = {};
  if (status) {
    if (!(RUN_STATUSES as readonly string[]).includes(status)) throw badRequest('Unknown status');
    filter.status = status as RunFilter['status'];
  }
  if (harness) {
    if (!(RUN_HARNESSES as readonly string[]).includes(harness))
      throw badRequest('Unknown harness');
    filter.harness = harness as RunFilter['harness'];
  }
  const before = queryString(req, 'before');
  if (before) filter.before = before;
  const beforeId = queryString(req, 'beforeId');
  if (beforeId) filter.beforeId = beforeId;
  const scheduleId = queryString(req, 'scheduleId');
  if (scheduleId) filter.scheduleId = scheduleId;
  const triggerId = queryString(req, 'triggerId');
  if (triggerId) filter.triggerId = triggerId;
  const parentRunId = queryString(req, 'parentRunId');
  if (parentRunId) filter.parentRunId = parentRunId;
  if (limit) filter.limit = Number(limit);
  return filter;
}

/** A run with its token usage, as the API returns it. */
function runView(launchpad: Launchpad, gateway: Gateway, run: Run) {
  const usage = run.sessionId ? gateway.llmUsage.totalsFor([run.sessionId]) : null;
  return { ...run, tokensUsed: usage?.total ?? 0 };
}

/** Read-only run routes shared by the member portal (own runs) and the admin (all runs). */
function runReadRoutes(
  router: Router,
  launchpad: Launchpad,
  gateway: Gateway,
  actorOf: (res: Response) => Actor,
): void {
  const run = (req: Request, res: Response): Run =>
    launchpad.visibleRun(actorOf(res), param(req, RUN_ID));

  router.get(
    '/runs/:id',
    h((req, res) => runView(launchpad, gateway, run(req, res))),
  );
  router.get(
    '/runs/:id/events',
    h((req, res) => {
      const after = Number(queryString(req, 'after') ?? -1);
      return launchpad.runs.events(run(req, res).id, Number.isFinite(after) ? after : -1);
    }),
  );
  router.get(
    '/runs/:id/activity',
    h((req, res) => {
      const r = run(req, res);
      return r.sessionId ? gateway.activity.forSessions([r.sessionId]) : [];
    }),
  );
  router.get(
    '/runs/:id/usage',
    h((req, res) => {
      const r = run(req, res);
      return r.sessionId ? gateway.llmUsage.byModel([r.sessionId]) : [];
    }),
  );
  router.get(
    '/runs/:id/outputs',
    h((req, res) => launchpad.runs.outputs(run(req, res).id)),
  );
  router.get('/runs/:id/outputs/*path', (req, res, next) => {
    try {
      const r = run(req, res);
      const parts = req.params.path as unknown as readonly string[];
      const path = parts.join('/');
      const file = launchpad.runs.outputStream(r.id, path);
      if (!file) throw notFound('Output file not found');
      sendFile(res, file, parts.at(-1) ?? 'output');
    } catch (err) {
      next(err);
    }
  });
  router.get(
    '/runs/:id/attachments',
    h((req, res) => launchpad.attachments.forRun(run(req, res).id)),
  );
  router.get('/runs/:id/attachments/:name', (req, res, next) => {
    try {
      const name = param(req, 'name');
      const file = launchpad.attachments.stream(run(req, res).id, name);
      if (!file) throw notFound('Attachment not found');
      sendFile(res, file, name);
    } catch (err) {
      next(err);
    }
  });
  router.post(
    '/runs/:id/cancel',
    h(async (req, res) =>
      runView(launchpad, gateway, await launchpad.cancel(actorOf(res), param(req, RUN_ID))),
    ),
  );
}

/** Whether a request announces a body larger than `max` bytes (it is checked as it streams too). */
const declaredOver = (req: Request, max: number): boolean =>
  Number(req.get('content-length') ?? 0) > max;

/** Sends a stored file, chunk by chunk, so a large file is never held in memory whole. */
function sendFile(
  res: Response,
  file: { size: number; chunks: Iterable<Buffer> },
  name: string,
): void {
  res
    .set('content-type', 'application/octet-stream')
    .set('content-length', String(file.size))
    .set('content-disposition', `attachment; filename="${name.replace(/"/g, '')}"`)
    .set('x-content-type-options', 'nosniff');
  pipeline(Readable.from(file.chunks), res).catch(() => {
    res.destroy();
  });
}

/** A workflow with its step runs (and their token usage), as the API returns it. */
function workflowView(launchpad: Launchpad, gateway: Gateway, workflow: WorkflowView) {
  return {
    ...workflow,
    steps: workflow.steps.map((s) => ({
      ...s,
      run: s.run && runView(launchpad, gateway, s.run),
    })),
  };
}

/** Workflow routes shared by the member portal (own workflows) and the admin (all). */
function workflowRoutes(
  router: Router,
  launchpad: Launchpad,
  gateway: Gateway,
  workflows: Workflows,
  actorOf: (res: Response) => Actor,
): void {
  const view = (w: WorkflowView) => workflowView(launchpad, gateway, w);
  router.get(
    WORKFLOW_PATH,
    h((req, res) => view(workflows.visible(actorOf(res), param(req, 'wid')))),
  );
  router.post(
    `${WORKFLOW_PATH}/cancel`,
    h(async (req, res) => view(await workflows.cancel(actorOf(res), param(req, 'wid')))),
  );
}

/** A schedule with its next runs, as the API returns it. */
function scheduleView(scheduler: Scheduler, schedule: Schedule) {
  return { ...schedule, nextRuns: scheduler.preview(schedule) };
}

const enabledSchema = z.object({ enabled: z.boolean() });

/** Schedule routes shared by the member portal (own schedules) and the admin (all). */
function scheduleRoutes(
  router: Router,
  scheduler: Scheduler,
  actorOf: (res: Response) => Actor,
): void {
  router.get(
    SCHEDULE_PATH,
    h((req, res) => scheduleView(scheduler, scheduler.visible(actorOf(res), param(req, 'sid')))),
  );
  router.patch(
    SCHEDULE_PATH,
    h((req, res) => {
      const { enabled } = enabledSchema.parse(req.body);
      return scheduleView(
        scheduler,
        scheduler.setEnabled(actorOf(res), param(req, 'sid'), enabled),
      );
    }),
  );
  router.delete(
    SCHEDULE_PATH,
    h((req, res) => {
      scheduler.delete(actorOf(res), param(req, 'sid'));
    }),
  );
}

/** Trigger routes shared by the member portal (own triggers) and the admin (all). */
function triggerRoutes(
  router: Router,
  triggers: Triggers,
  actorOf: (res: Response) => Actor,
): void {
  router.get(
    TRIGGER_PATH,
    h((req, res) => triggers.view(triggers.visible(actorOf(res), param(req, 'tid')))),
  );
  router.patch(
    TRIGGER_PATH,
    h((req, res) => {
      const { enabled } = enabledSchema.parse(req.body);
      return triggers.view(triggers.setEnabled(actorOf(res), param(req, 'tid'), enabled));
    }),
  );
  router.delete(
    TRIGGER_PATH,
    h((req, res) => {
      triggers.delete(actorOf(res), param(req, 'tid'));
    }),
  );
  router.get(
    CONVERSATIONS_PATH,
    h((req, res) => triggers.listConversations(actorOf(res), param(req, 'tid'))),
  );
  router.get(
    `${CONVERSATION_PATH}/messages`,
    h((req, res) => {
      const page = pageSchema.parse(req.query);
      return triggers.conversationMessages(
        actorOf(res),
        param(req, 'tid'),
        param(req, 'cid'),
        page,
      );
    }),
  );
  router.delete(
    CONVERSATION_PATH,
    h((req, res) => {
      triggers.deleteConversation(actorOf(res), param(req, 'tid'), param(req, 'cid'));
    }),
  );
}

const pageSchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

const receiveSchema = z.object({
  waitSeconds: z.number().min(0).max(MAX_RECEIVE_WAIT_SECONDS).default(0),
});
const replySchema = z.object({ text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS) });

/**
 * The agent's side of its conversation (`/api/session/conversation`), authenticated by its
 * session key: what it is, the events that arrive for it (waiting for one), and its replies.
 * Served on the VM listener too; runs outside a conversation get 404.
 */
export function conversationSessionRoutes(gateway: Gateway, triggers: Triggers): Router {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  const sessionOf = (req: Request) => {
    const key = bearerToken(req);
    if (!key) throw unauthorized('Missing session key');
    return gateway.resolveSession(key);
  };
  router.get(
    '/',
    h((req) => {
      const { conversation } = triggers.sessionConversation(sessionOf(req));
      return { key: conversation.key, runs: conversation.runs, pending: conversation.pending };
    }),
  );
  router.post(
    '/receive',
    h(async (req) => {
      const { waitSeconds } = receiveSchema.parse(req.body ?? {});
      const messages = await triggers.receive(sessionOf(req), waitSeconds);
      return { messages: messages.map(({ id, at, text }) => ({ id, at, text })) };
    }),
  );
  router.post(
    '/reply',
    created((req) => {
      const { text } = replySchema.parse(req.body);
      const { id, at } = triggers.reply(sessionOf(req), text);
      return { id, at };
    }),
  );
  return router;
}

/** Skill library routes shared by the member portal (own skills) and the admin (all). */
function skillRoutes(
  router: Router,
  skills: Skills,
  gateway: Gateway,
  actorOf: (res: Response) => Actor,
): void {
  router.get(
    SKILL_PATH,
    h((req, res) => skills.visible(actorOf(res), param(req, 'kid'))),
  );
  router.delete(
    SKILL_PATH,
    h((req, res) => {
      const actor = actorOf(res);
      const skill = skills.delete(actor, param(req, 'kid'));
      const by = actor.kind === 'admin' ? 'admin' : 'member';
      gateway.activity.add({
        kind: by,
        detail: `Deleted skill "${skill.name}" of member "${skill.memberName}"`,
      });
    }),
  );
}

/**
 * Files a member uploads for a launch to come (then launches with `attachmentIds`). The body is
 * the file, streamed into the database, not parsed into memory.
 */
function attachmentRoutes(
  router: Router,
  launchpad: Launchpad,
  memberOf: (res: Response) => Member,
): void {
  router.put(
    '/attachments/:name',
    created(async (req, res) => {
      if (declaredOver(req, ATTACHMENT_LIMITS.fileBytes)) {
        throw badRequest('File too large');
      }
      return launchpad.attachments.upload(memberOf(res).id, param(req, 'name'), req);
    }),
  );
  // Larger files are uploaded in parts, each small enough for a proxy in front of the gateway.
  router.post(
    '/attachments',
    created((req, res) =>
      launchpad.attachments.begin(memberOf(res).id, uploadSchema.parse(req.body).name),
    ),
  );
  router.put(
    '/attachments/:aid/parts',
    h(async (req, res) => {
      if (declaredOver(req, ATTACHMENT_LIMITS.partBytes)) throw badRequest('Part too large');
      const { offset } = partQuerySchema.parse(req.query);
      return launchpad.attachments.append(memberOf(res).id, param(req, ATTACHMENT_ID), offset, req);
    }),
  );
  router.post(
    '/attachments/:aid/complete',
    h((req, res) => launchpad.attachments.complete(memberOf(res).id, param(req, ATTACHMENT_ID))),
  );
  router.delete(
    '/attachments/:aid',
    h((req, res) => {
      launchpad.attachments.discard(memberOf(res).id, param(req, ATTACHMENT_ID));
    }),
  );
}

/** Member portal: launch agents and follow their own runs (mounted under `/api/me/launchpad`). */
export function memberLaunchRoutes(
  launchpad: Launchpad,
  gateway: Gateway,
  scheduler: Scheduler | null,
  triggers: Triggers | null = null,
  workflows: Workflows | null = null,
): Router {
  const router = express.Router();
  const memberOf = (res: Response): Member => res.locals.member as Member;
  const actorOf = (res: Response): Actor => ({ kind: 'member', member: memberOf(res) });

  router.get(
    '/',
    h((_req, res) => {
      const member = memberOf(res);
      const view = gateway.memberView(member);
      const settings = launchpad.runs.settings();
      return {
        enabled: launchpad.runs.memberLaunch(member.id).launchEnabled,
        driver: launchpad.driverName,
        defaultTimeoutSeconds: settings.defaultTimeoutSeconds,
        environments: launchpad.environments.choices(),
        skills: launchpad.skills
          .list(member.id)
          .map(({ name, description }) => ({ name, description })),
        templates: view.templates.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          tools: t.grants.map((g) => g.tool),
          maxTtlSeconds: t.maxTtlSeconds,
          harnesses: launchpad.harnessChoices(t),
          workflow: workflows && launchpad.workflowChoice(t),
        })),
      };
    }),
  );
  router.get(
    '/planners',
    h(async (_req, res) => ({ planners: await launchpad.plannerChoices(memberOf(res)) })),
  );
  router.get(
    '/templates/:templateId/models',
    h(async (req, res) => ({
      models: await launchpad.endpointModels(memberOf(res), param(req, 'templateId')),
    })),
  );
  router.get(
    '/runs',
    h((req, res) =>
      launchpad.runs
        .list({ ...runFilter(req), memberId: memberOf(res).id })
        .map((r) => runView(launchpad, gateway, r)),
    ),
  );
  router.post(
    '/runs',
    created((req, res) => {
      const { parentRunId, attachmentIds, instructions, attachmentsFrom } = launchNowSchema.parse(
        req.body,
      );
      const run = launchpad.launch(memberOf(res), req.body, {
        ...(parentRunId && { parentRunId }),
        ...(attachmentIds && { attachmentIds }),
        ...(instructions && { instructions }),
        ...(attachmentsFrom && { attachmentsFrom }),
      });
      return runView(launchpad, gateway, run);
    }),
  );
  runReadRoutes(router, launchpad, gateway, actorOf);
  attachmentRoutes(router, launchpad, memberOf);
  router.get(
    SKILLS_PATH,
    h((_req, res) => launchpad.skills.list(memberOf(res).id)),
  );
  skillRoutes(router, launchpad.skills, gateway, actorOf);
  if (scheduler) {
    router.get(
      SCHEDULES_PATH,
      h((_req, res) => scheduler.list(memberOf(res).id).map((x) => scheduleView(scheduler, x))),
    );
    router.post(
      SCHEDULES_PATH,
      created((req, res) => scheduleView(scheduler, scheduler.create(memberOf(res), req.body))),
    );
    scheduleRoutes(router, scheduler, actorOf);
  }
  if (triggers) {
    router.get(
      TRIGGERS_PATH,
      h((_req, res) => triggers.list(memberOf(res).id).map((x) => triggers.view(x))),
    );
    router.post(
      TRIGGERS_PATH,
      created((req, res) => triggers.view(triggers.create(memberOf(res), req.body))),
    );
    router.put(
      TRIGGER_PATH,
      h((req, res) => triggers.view(triggers.edit(memberOf(res), param(req, 'tid'), req.body))),
    );
    triggerRoutes(router, triggers, actorOf);
  }
  if (workflows) {
    router.get(
      WORKFLOWS_PATH,
      h((_req, res) =>
        workflows.list(memberOf(res).id).map((w) => workflowView(launchpad, gateway, w)),
      ),
    );
    router.post(
      WORKFLOWS_PATH,
      created((req, res) =>
        workflowView(launchpad, gateway, workflows.create(memberOf(res), req.body)),
      ),
    );
    workflowRoutes(router, launchpad, gateway, workflows, actorOf);
  }
  return router;
}

/** Admin: every run, settings and per-member launch rights (mounted under `/api/admin/launchpad`). */
export function adminLaunchRoutes(
  launchpad: Launchpad,
  gateway: Gateway,
  scheduler: Scheduler | null,
  triggers: Triggers | null = null,
  workflows: Workflows | null = null,
): Router {
  const router = express.Router();
  const actorOf = (): Actor => ({ kind: 'admin' });
  if (workflows) {
    router.get(
      WORKFLOWS_PATH,
      h(() => workflows.list().map((w) => workflowView(launchpad, gateway, w))),
    );
    workflowRoutes(router, launchpad, gateway, workflows, actorOf);
  }
  if (scheduler) {
    router.get(
      SCHEDULES_PATH,
      h(() => scheduler.list().map((x) => scheduleView(scheduler, x))),
    );
    scheduleRoutes(router, scheduler, actorOf);
  }
  if (triggers) {
    router.get(
      TRIGGERS_PATH,
      h(() => triggers.list().map((x) => triggers.view(x))),
    );
    triggerRoutes(router, triggers, actorOf);
  }

  router.get(
    '/runs',
    h((req) => {
      const filter = runFilter(req);
      const memberId = queryString(req, 'memberId');
      return launchpad.runs
        .list(memberId ? { ...filter, memberId } : filter)
        .map((r) => runView(launchpad, gateway, r));
    }),
  );
  runReadRoutes(router, launchpad, gateway, actorOf);
  router.get(
    SKILLS_PATH,
    h((req) => launchpad.skills.list(queryString(req, 'memberId'))),
  );
  skillRoutes(router, launchpad.skills, gateway, actorOf);

  router.get(
    '/settings',
    h(() => ({ ...launchpad.runs.settings(), driver: launchpad.driverName })),
  );
  router.put(
    '/settings',
    h((req) => {
      const settings: LaunchSettings = settingsSchema.parse(req.body);
      launchpad.runs.saveSettings(settings);
      gateway.activity.add({ kind: 'admin', detail: 'Updated launchpad settings' });
      void launchpad.pump();
      return settings;
    }),
  );
  router.get(
    '/members',
    h(() =>
      gateway.listMembers().map((m) => ({
        ...launchpad.runs.memberLaunch(m.id),
        name: m.name,
        activeRuns: launchpad.runs.countActive(m.id),
      })),
    ),
  );
  router.put(
    '/members/:memberId',
    h((req) => {
      const memberId = param(req, 'memberId');
      if (!gateway.listMembers().some((m) => m.id === memberId)) throw notFound('Member not found');
      const value = { memberId, ...memberLaunchSchema.parse(req.body) };
      launchpad.runs.saveMemberLaunch(value);
      gateway.activity.add({
        kind: 'admin',
        detail: `${value.launchEnabled ? 'Allowed' : 'Disabled'} agent launches for member ${memberId}`,
      });
      return value;
    }),
  );
  router.get(
    '/usage',
    h(() => gateway.llmUsage.byModel(null)),
  );
  environmentRoutes(router, launchpad, gateway);
  return router;
}

/** Admin: the guest environments members can launch agents in (built from Dockerfiles). */
function environmentRoutes(router: Router, launchpad: Launchpad, gateway: Gateway): void {
  const { environments } = launchpad;
  const logged = (env: GuestEnvironment, what: string): GuestEnvironment => {
    gateway.activity.add({ kind: 'admin', detail: `${what} guest environment "${env.name}"` });
    return env;
  };
  router.get(
    ENVIRONMENTS_PATH,
    h(async () => {
      await environments.refresh();
      return environments.list();
    }),
  );
  router.post(
    ENVIRONMENTS_PATH,
    created(async (req) => logged(await environments.create(req.body), 'Added')),
  );
  router.put(
    ENVIRONMENT_PATH,
    h(async (req) => logged(await environments.update(param(req, 'eid'), req.body), 'Updated')),
  );
  router.patch(
    ENVIRONMENT_PATH,
    h((req) => {
      const { enabled } = enabledSchema.parse(req.body);
      const env = environments.setEnabled(param(req, 'eid'), enabled);
      return logged(env, enabled ? 'Enabled' : 'Disabled');
    }),
  );
  router.post(
    `${ENVIRONMENT_PATH}/rebuild`,
    h(async (req) => logged(await environments.rebuild(param(req, 'eid')), 'Rebuilt')),
  );
  router.delete(
    ENVIRONMENT_PATH,
    h(async (req) => {
      logged(await environments.delete(param(req, 'eid')), 'Deleted');
    }),
  );
}

/**
 * Runner reports, authenticated by the run token (`Authorization: Bearer gwr_…`). Served on the
 * VM listener; the agent inside the VM doesn't have the token.
 */
export function runnerRoutes(launchpad: Launchpad): Router {
  const router = express.Router();
  const runOf = (req: Request): Run => launchpad.runnerRun(bearerToken(req));

  router.post(
    '/events',
    express.json({ limit: '8mb' }),
    h((req) => {
      const run = runOf(req);
      const { events } = eventsSchema.parse(req.body);
      return { stored: launchpad.reportEvents(run, events) };
    }),
  );
  // A chained run's input files (its parent's outputs), streamed like downloads.
  router.get('/inputs/*path', (req, res, next) => {
    try {
      const run = runOf(req);
      const parts = req.params.path as unknown as readonly string[];
      sendFile(res, launchpad.runnerInput(run, parts.join('/')), parts.at(-1) ?? 'input');
    } catch (err) {
      next(err);
    }
  });
  // The skills of the member's library the run starts with.
  router.get(
    '/skills',
    h((req) => ({ skills: launchpad.runnerSkills(runOf(req)) })),
  );
  // The body is streamed into the database (files reach 1 GiB), not parsed into memory.
  router.put(
    '/outputs/*path',
    h(async (req) => {
      const run = runOf(req);
      const path = (req.params.path as unknown as string[]).join('/');
      if (declaredOver(req, RUNNER_LIMITS.outputFileBytes)) {
        throw badRequest('Output file too large');
      }
      await launchpad.reportOutput(run, path, req);
    }),
  );
  router.post(
    '/finish',
    express.json({ limit: '2mb' }),
    h(async (req) => {
      const run = runOf(req);
      const finished = await launchpad.reportFinish(run, finishSchema.parse(req.body));
      return { status: finished.status };
    }),
  );
  return router;
}
