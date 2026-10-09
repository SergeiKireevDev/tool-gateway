import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../errors.js';
import type { Gateway } from '../gateway.js';
import { bearerToken } from '../http/auth.js';
import { created, h, param } from '../http/handlers.js';
import type { Member } from '../store/types.js';
import { SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from '../units.js';
import type { Actor, Launchpad } from './launchpad.js';
import type { Schedule, Scheduler } from './scheduler.js';
import type { Triggers } from './triggers.js';
import { HARNESSES, RUNNER_LIMITS } from './protocol.js';
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
    if (!(HARNESSES as readonly string[]).includes(harness)) throw badRequest('Unknown harness');
    filter.harness = harness as RunFilter['harness'];
  }
  const before = queryString(req, 'before');
  if (before) filter.before = before;
  const scheduleId = queryString(req, 'scheduleId');
  if (scheduleId) filter.scheduleId = scheduleId;
  const triggerId = queryString(req, 'triggerId');
  if (triggerId) filter.triggerId = triggerId;
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
      const content = launchpad.runs.output(r.id, path);
      if (!content) throw notFound('Output file not found');
      const name = parts.at(-1) ?? 'output';
      res
        .set('content-type', 'application/octet-stream')
        .set('content-disposition', `attachment; filename="${name.replace(/"/g, '')}"`)
        .set('x-content-type-options', 'nosniff')
        .send(content);
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
}

/** Member portal: launch agents and follow their own runs (mounted under `/api/me/launchpad`). */
export function memberLaunchRoutes(
  launchpad: Launchpad,
  gateway: Gateway,
  scheduler: Scheduler | null,
  triggers: Triggers | null = null,
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
        templates: view.templates.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          tools: t.grants.map((g) => g.tool),
          maxTtlSeconds: t.maxTtlSeconds,
          harnesses: launchpad.harnessChoices(t),
        })),
      };
    }),
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
    created((req, res) => runView(launchpad, gateway, launchpad.launch(memberOf(res), req.body))),
  );
  runReadRoutes(router, launchpad, gateway, actorOf);
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
  return router;
}

/** Admin: every run, settings and per-member launch rights (mounted under `/api/admin/launchpad`). */
export function adminLaunchRoutes(
  launchpad: Launchpad,
  gateway: Gateway,
  scheduler: Scheduler | null,
  triggers: Triggers | null = null,
): Router {
  const router = express.Router();
  const actorOf = (): Actor => ({ kind: 'admin' });
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
  return router;
}

const OUTPUT_BODY_LIMIT = RUNNER_LIMITS.outputFileBytes;

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
  router.put(
    '/outputs/*path',
    express.raw({ type: () => true, limit: OUTPUT_BODY_LIMIT }),
    h((req) => {
      const run = runOf(req);
      const path = (req.params.path as unknown as string[]).join('/');
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      launchpad.reportOutput(run, path, body);
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
