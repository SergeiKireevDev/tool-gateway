import { badRequest, conflict, notFound } from '../errors.js';
import type { Gateway } from '../gateway.js';
import { randomId } from '../store/crypto.js';
import type { Member } from '../store/types.js';
import { type Actor, type Launchpad, launchSchema, MAX_PROMPT_LENGTH } from './launchpad.js';
import { type RunHarness, SCRIPT_FILE, SCRIPT_HARNESS } from './protocol.js';
import {
  isActive,
  type Run,
  type RunStatus,
  type Workflow,
  WORKFLOW_STEPS,
  type WorkflowStep,
} from './runStore.js';
import { OUT_DIR } from './systemPrompt.js';

/**
 * A workflow launch: the task, the template the script runs with, the script's model and the
 * planning agent. The planner may run on any template the member has (by default the workflow's):
 * it gets none of that template's tools, so only its model API matters.
 */
export const workflowSchema = launchSchema.extend({
  /** The model of the template's custom LLM endpoint the script uses. */
  executorModel: launchSchema.shape.model,
  /** The template whose model API the planning agent uses; the workflow's template if unset. */
  plannerTemplateId: launchSchema.shape.templateId.optional(),
  /** The planner's model provider account, when the member has several. */
  plannerAccountIds: launchSchema.shape.accountIds,
});

export interface WorkflowStepView {
  step: WorkflowStep;
  /** The template the step's run uses. */
  templateName: string;
  harness: RunHarness;
  model: string | null;
  /** The step's run, once launched. */
  run: Run | null;
}

/** A workflow with its steps and the status they add up to. */
export interface WorkflowView extends Workflow {
  status: RunStatus;
  statusReason: string | null;
  steps: WorkflowStepView[];
}

const WORKFLOW_NOT_FOUND = 'Workflow not found';

/**
 * Two-step workflows: a frontier agent with no tool access writes a script for the task, then the
 * execution container runs that script on the template's custom LLM endpoint and tools. The
 * second step is launched when the first one succeeds. The planner can be any agent the member
 * may launch, from any of their templates: its key covers that template's model API only.
 */
export class Workflows {
  constructor(
    private readonly gateway: Gateway,
    private readonly launchpad: Launchpad,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Checks both steps like launches (so none fails later for a reason known now), then plans. */
  create(member: Member, input: unknown): WorkflowView {
    const req = workflowSchema.parse(input);
    const planner = this.launchpad.plan(
      member,
      {
        prompt: req.prompt,
        templateId: req.plannerTemplateId ?? req.templateId,
        accountIds: req.plannerTemplateId ? req.plannerAccountIds : req.accountIds,
        harness: req.harness,
        model: req.model,
      },
      'plan',
    );
    const executor = this.launchpad.planScript(
      member,
      { templateId: req.templateId, accountIds: req.accountIds, model: req.executorModel },
      req.prompt,
    );
    if (executor.model === null) throw badRequest('Name the model the script uses');
    const workflow = this.launchpad.runs.insertWorkflow({
      id: randomId(),
      memberId: member.id,
      memberName: member.name,
      prompt: planner.prompt,
      templateId: executor.template.id,
      templateName: executor.template.name,
      accountIds: executor.accountIds,
      plannerTemplateId: planner.template.id,
      plannerTemplateName: planner.template.name,
      plannerHarness: req.harness,
      plannerModel: planner.model,
      executorModel: executor.model,
      createdAt: this.now().toISOString(),
    });
    this.launchpad.launchPlan(member, planner, { workflowId: workflow.id, workflowStep: 'plan' });
    return this.view(workflow);
  }

  /** Launches the script once its planner succeeded; called for every finished run. */
  onRunFinished(run: Run): void {
    if (run.workflowStep !== 'plan' || !run.workflowId || run.status !== 'succeeded') return;
    const workflow = this.launchpad.runs.workflow(run.workflowId);
    if (!workflow) return;
    try {
      this.execute(workflow, run);
    } catch (err) {
      const reason = (err as Error).message;
      this.launchpad.runs.failWorkflow(workflow.id, reason);
      this.gateway.activity.add({
        kind: 'launchpad',
        detail: `Workflow ${workflow.id} failed: ${reason}`,
      });
    }
  }

  private execute(workflow: Workflow, plan: Run): void {
    const file = this.launchpad.runs.output(plan.id, SCRIPT_FILE);
    if (!file || file.toString('utf8').trim() === '') {
      throw new Error(`The planning agent wrote no script (${OUT_DIR}/${SCRIPT_FILE})`);
    }
    const script = file.toString('utf8');
    if (script.length > MAX_PROMPT_LENGTH) {
      throw new Error(`The script is longer than ${MAX_PROMPT_LENGTH} characters`);
    }
    const member = this.gateway.activeMember(workflow.memberId);
    if (!member) throw new Error('The member is gone or expired');
    const checked = this.launchpad.planScript(
      member,
      {
        templateId: workflow.templateId,
        accountIds: workflow.accountIds,
        model: workflow.executorModel,
      },
      script,
    );
    this.launchpad.launchPlan(member, checked, {
      workflowId: workflow.id,
      workflowStep: 'execute',
    });
  }

  list(memberId?: string): WorkflowView[] {
    return this.launchpad.runs.workflows(memberId).map((w) => this.view(w));
  }

  /** A workflow the actor may see: members only their own. */
  visible(actor: Actor, id: string): WorkflowView {
    const workflow = this.launchpad.runs.workflow(id);
    if (!workflow || (actor.kind === 'member' && workflow.memberId !== actor.member.id)) {
      throw notFound(WORKFLOW_NOT_FOUND);
    }
    return this.view(workflow);
  }

  /** Stops the step that is going: the next one is then never launched. */
  async cancel(actor: Actor, id: string): Promise<WorkflowView> {
    const workflow = this.visible(actor, id);
    const active = workflow.steps.find((s) => s.run && isActive(s.run.status))?.run;
    if (!active) throw conflict(`Workflow already ${workflow.status}`);
    await this.launchpad.cancel(actor, active.id);
    return this.visible(actor, id);
  }

  view(workflow: Workflow): WorkflowView {
    const runs = this.launchpad.runs.workflowRuns(workflow.id);
    const steps = WORKFLOW_STEPS.map((step): WorkflowStepView => ({
      step,
      templateName: step === 'plan' ? workflow.plannerTemplateName : workflow.templateName,
      harness: step === 'plan' ? workflow.plannerHarness : SCRIPT_HARNESS,
      model: step === 'plan' ? workflow.plannerModel : workflow.executorModel,
      run: runs.find((r) => r.workflowStep === step) ?? null,
    }));
    return { ...workflow, ...workflowStatus(workflow, steps), steps };
  }
}

/** The step that is going or ended last decides: a workflow succeeds when its script did. */
function workflowStatus(
  workflow: Workflow,
  steps: WorkflowStepView[],
): { status: RunStatus; statusReason: string | null } {
  const last = steps.findLast((s) => s.run !== null)?.run;
  if (workflow.failure !== null) return { status: 'failed', statusReason: workflow.failure };
  if (!last) return { status: 'queued', statusReason: null };
  // The planner succeeded and the script is being launched.
  if (last.status === 'succeeded' && last.workflowStep !== WORKFLOW_STEPS.at(-1)) {
    return { status: 'running', statusReason: null };
  }
  return { status: last.status, statusReason: last.statusReason };
}
