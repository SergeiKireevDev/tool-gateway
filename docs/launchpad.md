# Agent launchpad

Members launch AI agents from the gateway. Each agent runs in a disposable Firecracker microVM
whose only network peer is the gateway. Its tool calls **and** its model calls go through the
gateway with one session key, scoped by the permission template the member picked.

```
member (Google sign-in) ──▶ gateway UI ──▶ launchpad (in the gateway process)
                                             │ issues gws_ for the member (template ∩ accounts),
                                             │ TTL = run time limit + 5 min, token budget
                                             ▼
                                  vmd (root daemon, unix socket)
                                             │ jailed Firecracker VM, private rootfs copy,
                                             │ read-only config drive, isolated tap
                                             ▼
                 microVM ──(gws_; only reachable host: the gateway's VM listener)──▶ gateway
                   runner (root) → harness as `agent`        /proxy/github|monday|slack|…  tools
                   gateway MCP server / pi extension         /proxy/anthropic|openai|gemini  models
                   reports with its gwr_ run token ────────▶ /runner/events|outputs|finish
```

## What a run is

1. **Launch.** A member picks a task (prompt), a template, a harness (Claude Code, Codex, Gemini
   CLI or pi), optionally a [guest environment](#guest-environments) and
   [attachments](#attachments), and "now", a schedule or a webhook trigger. The launchpad checks the following, then queues the run:
   - the member may launch;
   - the template is theirs;
   - one account per tool is available;
   - the template grants the model API the harness needs;
   - the template's max TTL allows a run.
2. **Start.** When there is capacity (global and per-member limits), the launchpad:
   - issues the run's session key: the template's grants, a TTL of the time limit + 5 min, and the
     run's token budget;
   - creates a per-run token (`gwr_`, stored hashed);
   - asks the VM driver to boot.
3. **Run.** In the VM, the runner reads its config from `/dev/vdb` (root only) and starts the
   harness as user `agent`. The harness reaches:
   - the model API through `/proxy/<provider>`;
   - the tools through the gateway MCP server (or the pi extension);
   - git: `https://github.com/…` URLs are rewritten to the gateway's git endpoint, so `git clone`
     and `git push` of allowed repositories work. Pushes to the default branch are refused.

   The runner streams the normalized transcript and stops the agent at the deadline.

4. **Finish.** The runner uploads `/home/agent/out` (at most 200 files, 1 GiB per file and
   2 GiB in all; files it can't keep are listed in the run's status reason), `MEMORY.md` and the
   skills the agent exported to the [skill library](#skill-library), then
   reports the result. Output files are streamed from disk and stored in 4 MiB chunks, so neither
   the VM nor the gateway holds a whole file in memory. The launchpad then **always** revokes the key and destroys the VM. A reaper does the same for runs
   whose VM died, that passed their deadline, or that were left by a gateway restart. It also
   destroys VMs that no run owns.

Scheduled agents use Hourly, Daily, Weekly or Monthly presets in the member's time zone:

- A run is skipped while the previous one is still going.
- Each successful run's `MEMORY.md` is given to the next run.
- A schedule **stops** when its member's key is rotated or revoked, or when the member is deleted
  or expired. The member can resume it; the admin can pause it.

## Guest environments

By default, agent VMs boot the guest image built from `deploy/guest-image/Dockerfile` (Node 22,
git, Python, the agent CLIs). The admin can add other environments under **Launchpad → Guest
environments**, by pasting or uploading a Dockerfile (or `POST /api/admin/launchpad/environments`
with `name`, `description` and `dockerfile`). Members then pick one in the launch form's
**Environment** field (`environmentId` on runs, schedules and triggers).

- **Building.** The gateway hands the Dockerfile to vmd, which runs
  `deploy/build-custom-image.sh` in the background: `docker build`, with the launchpad's own
  layers added on top of the last stage (the runner bundle, `/sbin/launchpad-init` and the
  `agent` user), then the image is exported to `/var/lib/launchpad/images/<id>.ext4`. The
  environment is `building` until then, and `ready` or `failed` after, with the end of the build
  log in the admin UI. Rebuild it to pick up a newer base image; a changed Dockerfile is rebuilt.
- **What the Dockerfile needs.** The runner needs Node 22, `tini` and `iproute2`, and the agent
  its CLI: start it `FROM launchpad-guest:latest` (tagged by `deploy/build-guest-image.sh`) and
  add what the agents need. The VM's network lockdown doesn't depend on the image: whatever it
  holds, it can only reach the gateway.
- **Allowlist.** Members only see environments that are built and that the admin left enabled
  (**Members can pick it**). A launch, schedule or trigger naming another one is refused, and a
  queued run whose environment was disabled, deleted or is being rebuilt fails when it would
  start, like schedules and triggers then stop.
- **Trust.** `docker build` runs on the VM host with vmd's privileges: only the admin adds
  Dockerfiles. Workflows boot the default image.

The `local-unsafe` driver builds nothing: environments are marked ready at once, and its runs use
the gateway host whatever the environment.

## Webhook triggers

A trigger launches an agent for each accepted delivery on one of the member's own
[webhooks](../README.md#webhooks), or on one the admin shares with every member (**New agent → On
a webhook event**, or
`POST /api/me/launchpad/triggers`):

```json
{
  "name": "Triage new issues",
  "webhookId": "<webhook id>",
  "eventTypes": ["issues.opened"],
  "filters": { "contains": ["crash"], "assignedTo": ["octocat"] },
  "instructions": "Label the issue and post a short summary in #triage.",
  "templateId": "<template id>",
  "harness": "claude-code"
}
```

- **Input.** The trigger's `instructions` are added to the agent's system prompt. The task (user
  prompt) is the event: its type, the webhook, and the payload as JSON, redacted like the logged
  one and capped to the prompt size. The system prompt tells the agent that the payload comes from
  a third party and is data, not instructions.
- **Event types.** Empty matches every delivery. `issues` matches `issues` and its sub-types
  (`issues.opened`). Event types are those shown in the webhook's log: monday.com's `event.type`,
  Linear's `type.action` (`Issue.create`), GitHub's `X-GitHub-Event` + `action`
  (`pull_request.opened`), or a generic `type` / `event` field.
- **Filters.** Optional, deterministic conditions on the payload, checked before an agent is
  launched (a delivery that fails them launches nothing). Each is a list of values, any of which
  matches, case-insensitively; every filter that is set must match:
  - `contains`: one of the keywords appears in one of the payload's text values (not its keys).
  - `statusChangedTo`: the event moves an item to one of these statuses: a Linear issue update
    that changes its state (the state's name, e.g. `Todo`), a GitHub issue or pull request
    `closed` (and `merged`) or `reopened` (`open`), a GitHub project item's field set to an
    option (`In review`), or a monday.com status column set to a label.
  - `assignedTo`: the event assigns an item to one of these people: a Linear issue created with,
    or updated to, an assignee (id, name or email), GitHub's `assigned` action (login or id), or
    people added to a monday.com people column (user id).
- **Permissions.** The template, accounts, harness and model are checked like a launch when the
  trigger is created and resumed, and again on each launch. Only the member's own webhooks and
  the admin's shared ones can trigger their agents; a delivery on a shared webhook launches the
  matching triggers of every member. A trigger on a webhook the admin no longer shares stops at
  its next delivery, and can be resumed once it is shared again.
- **Limits.** A trigger has at most 3 runs queued or running; further deliveries are skipped (and
  logged in Activity). The usual concurrency limits and token budget apply to each run.
- **Editing.** The member can change everything a trigger does and listens to (**Edit** in the
  triggers table, or `PUT /api/me/launchpad/triggers/<id>` with the same body as when creating
  it). The new settings are checked like a new trigger's; the name stays unless one is given, and
  a paused trigger stays paused. Runs already launched keep the instructions they started with.
  The admin can't edit a member's trigger.
- **Stopping.** Like schedules, a trigger stops when its member's key is rotated or revoked, when the
  member is deleted or expired, or when a launch fails. The member can resume it; the admin can
  pause it. Deleting the webhook leaves the trigger without events.

### Conversations

A trigger on a conversation channel is a conversation trigger: instead of one independent agent
per delivery, the deliveries whose payload gives the same key are the messages of one long-lived
conversation (a Linear issue's comments, a GitHub pull request's reviews, a chat thread…). One
agent at a time serves a conversation; it receives the conversation's new events while it runs,
and when it has finished, the next event revives the conversation in a new run that starts from
its history and memory. [Duplex conversations, explained](conversations.md) walks through how it
works and how to design a channel.

- **Channels are the admin's.** A conversation's agent hears whoever can post to the webhook's
  source, and lives on across runs, so members don't write conversation keys: the admin defines
  **conversation channels** (**Launchpad → Conversation channels**, or
  `POST /api/admin/launchpad/channels` with `name`, `description`, `conversationKey`,
  `eventTypes`, `sources`, `filters`, `templateId` and `agentTtlSeconds`; `PUT`,
  `PATCH {enabled}` and `DELETE …/channels/<id>`). Members see the enabled ones in
  `GET /api/me/launchpad` (`channels`) and create agents as a conversation channel: **When → As
  a conversation channel** in the launch form (listed once the admin enabled a channel they can
  pick), then the webhook and one of the channels that carry its source (`channelId`; none, with
  **On a webhook event**: one agent per delivery). An edited trigger can switch between the two.
  A trigger body with a `conversationKey` of its own is refused, and so is one on a channel with
  `eventTypes` or `filters` of its own: the admin set them on the channel (the launch form doesn't
  ask for them).
- **Accounts are the member's.** A channel sets no accounts: the agents of a conversation trigger
  use the accounts its member picked, like any launch. To handle conversations with dedicated
  accounts (a bot's), the admin creates a member for them, grants it those accounts (or lets it
  connect its own) and creates the conversation triggers as that member.

  ```json
  {
    "name": "Answer issue comments",
    "webhookId": "<webhook id>",
    "channelId": "<channel id>",
    "instructions": "Answer each new comment on the issue, in the issue.",
    "templateId": "<template id>",
    "harness": "claude-code"
  }
  ```

  A disabled or deleted channel can't be picked, and a trigger on it stops at its next delivery
  (its member resumes it once the admin enables the channel again). Editing a channel's key
  applies to the next deliveries of every trigger on it. Keys that members set before channels
  existed became disabled channels named `Key …`, for the admin to review.

- **The types of notification.** A channel's `eventTypes` (like a trigger's: `Comment` also
  matches `Comment.create`; empty: every event) are the notifications it carries, e.g.
  `["Comment.create"]` for a Linear issue's comments but not its updates. A delivery of another
  type is no message of a trigger on the channel: it opens no conversation and starts no run.
  Triggers on the channel set no event types of their own. Members see them
  with the channel (`eventTypes` in `channels`, `channelEventTypes` on the trigger); editing them
  applies to the next deliveries.

- **Like a trigger.** A channel picks the deliveries it carries with the same machinery as
  triggers: besides its event types, its `sources` (the webhook sources, `monday`, `linear`,
  `github` or `generic`; empty: any) and its `filters` (`contains`, `statusChangedTo`,
  `assignedTo`, as a trigger's; triggers on the channel set none of their own). Only triggers on a
  webhook of one of its sources can pick it (the launch form lists only those). Only its key and
  its agents differ:
  - `templateId`: the access template its agents get (null: the trigger's own). Members only see
    the channels whose template is one of theirs, and a trigger on the channel must use it. When
    the admin changes it, the next runs of its triggers get the new template (with the member's
    accounts for it picked anew); a run that can no longer launch stops its trigger.
  - `agentTtlSeconds`: how long each of its agents may live, from 5 minutes to 24 hours, instead
    of the launchpad's default run timeout (null), so that an agent can hold a long session. It
    is capped by its template's max TTL (less the 5 minutes session keys outlive a run); a channel
    whose template's keys can't last that long is refused. Triggers' views carry it as
    `channelAgentTtlSeconds`.

- **The key.** The channel's jq-like expression on the (redacted) payload, checked when the
  channel is saved. The key is the expression's non-null values: a single string as is, anything else as JSON
  (`[.repository.full_name, .issue.number]` gives `["o/r",42]`). A delivery whose payload gives
  no key (null, an error, or more than 200 characters) launches nothing and is logged in Activity.
  The language is a subset of jq:
  - paths: `.`, `.a.b`, `."a key"`, `.["a key"]`, `.[0]`, `.[-1]`, `.[]`, and `?` to ignore
    errors (`.a.b?`);
  - literals (strings, numbers, `true`, `false`, `null`), arrays `[…]` and objects
    `{a: .x, b, "c": .y, (.k): .v}`;
  - `|`, `,`, `//` (alternative), `or`, `and`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `+`
    (numbers, strings, arrays, objects) and parentheses;
  - functions: `select(f)`, `map(f)`, `first`, `last`, `first(f)`, `length`, `keys`, `has(k)`,
    `type`, `not`, `empty`, `tostring`, `tojson`, `ascii_downcase`, `ascii_upcase`, `join(s)`,
    `split(s)`, `ltrimstr(s)`, `rtrimstr(s)`, `startswith(s)`, `endswith(s)`.

  No variables, definitions, regular expressions or recursion: an expression is at most 500
  characters and yields at most 1000 values, so it can't hang the gateway.

- **Messages.** Each delivery that passes the channel's sources, event types and filters is an `in`
  message of its conversation (opened on its first one). When no agent serves the conversation,
  a run starts with the waiting messages as its task (as many as fit in a prompt; the others wait
  for it to ask). Otherwise the message waits for the running (or queued) agent.
- **The agent's side.** A conversation's run has two more tools (MCP server and pi extension),
  backed by `/api/session/conversation` with its session key (served on the VM listener; other
  runs get 404):
  - `gateway_conversation_receive` (`waitSeconds`, up to 300, default 60) returns the messages
    that arrived since it last asked, or waits for one (`POST …/receive`, at most 50 s per
    request: the tool asks again for longer waits). The runner tells Codex to allow tool calls
    that long.
  - `gateway_conversation_reply` (`text`) records an `out` message of the agent's
    (`POST …/reply`). It doesn't reach the third party: the agent answers there with its tools.

  Its system prompt explains the conversation and its tools, and asks it to wait for more events
  while the exchange goes on, then to finish: it needn't stay until its deadline.

- **Revival.** When a conversation's run ends, its final message is recorded as an `out` message
  and the `MEMORY.md` it left (if any) is kept for the conversation. Messages that arrived and the
  agent never asked for start the next run right away; otherwise the next delivery does. A
  revived run gets the conversation's memory as `MEMORY.md`, and its system prompt lists the
  conversation's earlier messages (the latest 20,000 characters, each clipped to 4,000), marked as
  third-party data.
- **Limits.** The trigger's runs count against its 3 runs queued or running, but a delivery of a
  conversation is never dropped: it waits, and conversations waiting for room are served, the
  longest waiting first, as the trigger's runs end. A run serves one conversation; a conversation
  has at most one run at a time.
- **Seeing and forgetting.** The triggers table links to a conversation trigger's conversations
  (key, runs, messages waiting, memory) and their messages:
  `GET …/triggers/<id>/conversations` and `GET …/triggers/<id>/conversations/<cid>/messages`
  (`?after=<message id>&limit=`), for its member and the admin. `DELETE …/conversations/<cid>`
  forgets one (history and memory): the next delivery with its key starts a new conversation; a
  run still serving it loses its conversation tools. Conversations live as long as their trigger;
  changing the trigger's channel, or the channel's key, leaves the existing conversations under
  their old keys.

## Attachments

A member can attach files to an agent launched now (**Attachments** in the launch form). The agent
finds them in `/home/agent/in` when it starts.

- **Upload, then launch.** Each file is uploaded first (`PUT /api/me/launchpad/attachments/<name>`,
  the raw file as the body, `content-type: application/octet-stream`), which returns its `id`. The
  launch then names them (`attachmentIds` in `POST /api/me/launchpad/runs`). Uploads are streamed
  into the database in 4 MiB chunks, like output files. Names are plain file names: letters,
  digits, dots, dashes and underscores (the form replaces other characters with `_`).
- **Upload in parts.** A proxy or tunnel in front of the gateway often caps the size of a request
  (Cloudflare at 100 MB) or its duration, so the form uploads every file in parts of 32 MiB:
  `POST /api/me/launchpad/attachments` with `{"name": "<name>"}` starts an upload and returns its
  `id`; `PUT /api/me/launchpad/attachments/<id>/parts?offset=<bytes>` appends a part (at most
  32 MiB, raw body) at the size received so far (another offset is refused with 409, so a part
  that failed is simply sent again); `POST /api/me/launchpad/attachments/<id>/complete` finishes
  it. Only complete uploads can be launched with; unfinished ones are deleted after a day.
- **Limits.** At most 20 files per launch, 1 GiB per file and 2 GiB in all. The same limits apply
  to files uploaded (or being uploaded) but not launched with yet.
- **Checks.** An attachment is the member's own, and goes with one launch only. Two attachments
  of a launch can't have the same name. Schedules and triggers take no attachments; workflows
  take them per step (see below).
- **Input.** When the run starts, its attachments are added to its input files
  (`GET /runner/inputs/<name>`), and its system prompt lists them. A chained run gets both its
  attachments and its parent's output files; an attachment replaces a parent file of the same name.
- **Keeping them.** The run's page lists its attachments (`GET …/runs/<id>/attachments[/<name>]`,
  for the member and the admin). They are deleted when the run's output files would be: after the
  output retention, counted from the run's end. Files not launched with are deleted after a day
  (`DELETE /api/me/launchpad/attachments/<id>` removes one earlier); the form deletes them itself
  when the launch fails.

## Chaining agents

An agent can start from what another one produced. On the page of one of their finished runs that
left output files, a member clicks **Chain an agent**: the launch form opens chained after that run
(its parent). It runs once, now (or `POST /api/me/launchpad/runs` with `parentRunId`).

- **Inputs.** Before the agent starts, the runner downloads the parent's output files into
  `/home/agent/in` (`GET /runner/inputs/<path>`, with the run token, streamed like downloads). The
  agent's system prompt lists them, and tells it they come from another agent: data, not
  instructions. The task says what to do with them. Files that expired before the run started are
  not there.
- **Checks.** The parent must be one of the member's own runs, finished, with at least one output
  file. The new run is otherwise an ordinary launch: any template, agent, model and environment
  the member may use.
- **Environment.** The form starts on the environment the parent ran in (the default one if the
  parent's is no longer offered); the member can pick another. Over the API, `environmentId` is
  independent of the parent: leave it out for the default environment.
- **The chain.** The run records its parent (`parentRunId`). Its page shows the chain as a graph:
  the parent node, the run, and the runs chained after it (`GET …/runs?parentRunId=<id>`); a click
  opens a node's run.

## Edit and relaunch

To retry a run, possibly with one thing changed, a member clicks **Edit and relaunch** on the page
of one of their finished agent runs (not a workflow step). The launch form opens filled with the
run's settings: its task, template, agent, model, environment, skills and accounts. They are
checked against the templates as they are configured now: what the member can no longer use
(a template withdrawn, a model no longer allowed, an environment or skill removed) is left out,
and the form says so. The member edits what they need; the new agent runs once, now, as an
ordinary launch.

- **Webhook-triggered runs.** The form shows the trigger's instructions and the event (the task)
  as two fields. The relaunch sends the instructions with `instructions` in
  `POST /api/me/launchpad/runs`: they go in the system prompt as for a trigger's run. The new run
  belongs to no trigger.
- **Input files.** A chained run is relaunched chained after the same parent (`parentRunId`), and a
  run with attachments gets copies of them (`attachmentsFrom: <runId>`, one of the member's own
  runs); either can be unticked. Files attached to the relaunch are added, and replace a copied
  file of the same name. The per-launch limits count both.

## Skill library

Agents leave what they learned for the next ones. Their system prompt asks them to export, before
they finish, everything they learned during the session that would help a future agent: how the
systems and tools they used behave, requests that worked, pitfalls and workarounds. Each skill is a
`SKILL.md` (YAML frontmatter with `name` and `description`, then Markdown instructions) in
`/home/agent/skills/<name>/`.

- **Export.** When the agent exits, the runner reads `/home/agent/skills/*/SKILL.md` (at most 20
  skills of 64 KiB each; names are lowercase letters, digits and dashes) and sends them with its
  result (`skills` in `POST /runner/finish`). It doesn't follow symlinks, and lists the skills it
  skipped in the run's log. Skills are kept whatever the run's outcome: what a failed run learned
  helps too.
- **Library.** The gateway keeps them in its database, per member: a skill named like one of the
  member's existing skills replaces it (agents are told to improve, not duplicate). Credentials
  are redacted, like in transcripts. Members see their own under **Skills**
  (`GET /api/me/launchpad/skills`, `GET|DELETE …/skills/<id>`); the admin sees everyone's
  (`GET /api/admin/launchpad/skills[?memberId=]`) and can delete them.
- **Starting with skills.** A launch can give the agent skills from its member's library
  (`skills: [<name>…]` in `POST …/runs`, `…/schedules` and `…/triggers`; the **Skills** checkboxes
  of the launch form, listed by `GET /api/me/launchpad`). Names not in the member's library are
  refused. Schedules and triggers keep them for each run they launch. When the run starts, its
  config names them (`skills`); the runner fetches their current content (`GET /runner/skills`)
  into `/home/agent/skills/<name>/SKILL.md` before starting the agent, and the system prompt lists
  them with their descriptions. Skills deleted from the library in the meantime are left out.
  The agent may improve them in place: on export, the runner leaves out the skills it was given
  and didn't change, so only real changes replace them in the library. Workflows don't take
  skills.

## Workflows: plan, then execute

A workflow splits a task between a frontier agent and an **execution container**: the frontier
agent writes a script, and the script does the work on a local model. Mail, issues and other
third-party data then only ever reach the template's custom LLM endpoint, and what the script may
do with the model's answers is fixed in code before it reads any of them.

In the launch form, the workflow is listed once with the templates, under **Workflows: Plan, then
execute** (or `POST /api/me/launchpad/workflows`). The member then picks each step. Both steps are
checked like launches when the workflow is created.

1. **Plan.** The planning agent and its model, from **any** model provider the member can use
   (`harness`, `plannerProvider`, `model` and, if the member has several accounts for that
   provider, `plannerAccountIds`). No permission template is picked: the planner gets no tool.
   The form lists every agent and model API the member's templates give
   (`GET /api/me/launchpad/planners`, with the models custom endpoints list), and the gateway
   issues the planner's key on the first of their templates that gives that model API and model
   (recorded as `plannerTemplateId`). That key covers the model API only, **none** of the
   template's tools. The planner's system prompt describes the execution container (the
   script template's tools, permissions and scopes, and its LLM endpoint if any) and asks for
   `/home/agent/out/script.mjs`.
2. **Execute.** The member picks **any** template for the script (`templateId`, `accountIds`).
   When the plan succeeds, the gateway launches the script (at most 50,000 characters) in a fresh
   VM with the `script` harness: no agent CLI, the runner runs `node script.mjs` as `agent`. Its
   key covers the template's tools and its custom LLM endpoint, but not the official model APIs.
   It gets `GATEWAY_URL` and `GATEWAY_SESSION_KEY`, and when the template grants a custom LLM
   endpoint, `LLM_URL` (`/proxy/custom`), `LLM_API` and `LLM_MODEL` (`executorModel`, the
   endpoint's model). Without one, the script has no LLM (`executorModel` is null): the planner is
   told to decide everything in code. Each line it prints is logged, and everything it printed is
   its final message.

**Attachments.** Each step can have files attached, uploaded beforehand like a launch's
(**Attachments** in each step of the form): `planAttachmentIds` for the planning agent,
`executeAttachmentIds` for the script. Each list is checked like a launch's (the member's own, not
launched with yet, within the per-launch limits), and a file goes with one step only. The planner's
files are its input files (`/home/agent/in`, listed in its system prompt). The script's are held
for the workflow until its step is launched, then given to that run and copied to its
`/home/agent/in` before `node script.mjs` starts. The planner never gets their content (they may
hold third-party data, which only the script handles): its system prompt lists their names and
sizes, for the script to read them. Files held for a script that never runs are deleted when the
planning step's output files would be.

A workflow's status follows its steps: it fails when the plan fails or writes no script, and
succeeds when the script exits with code 0. Stopping a workflow
(`POST …/workflows/<id>/cancel`) stops the step that is going, and no further step starts. Each
step is an ordinary run (its own key, VM, time limit and token budget), listed with the other runs;
opening one shows the workflow as a graph of its steps, whose nodes and edges show how far it got.
Workflows run once, now: they can't be scheduled or triggered yet.

## Guarantees and where they come from

| Guarantee                                                         | Mechanism                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| An agent can do no more than its member could                     | Keys are issued in-process with the member-key narrowing, re-checked inside the store mutation (`gateway.issueSessionForRun`)            |
| Keys and VMs never outlive their run                              | `Launchpad.finish` revokes and destroys; the reaper runs every minute; the key TTL is the run time limit + 5 min                         |
| Agents reach only their template's internet domains               | The egress proxy (`src/server/http/egressProxy.ts`) checks each `CONNECT` against the key's domains and refuses non-public addresses     |
| VMs reach the gateway only                                        | `deploy/vm-host-setup.sh`: nftables drops forwarding off the bridge and all host ports but the gateway's; taps are isolated bridge ports |
| The VM listener exposes nothing else                              | `createVmApp` serves only `/proxy/*`, `/api/session` and `/runner/*`                                                                     |
| The model API key never enters the VM                             | LLM providers (`src/server/tools/llm`) swap the session key for the real key; their auth errors are not relayed                          |
| Model spend is bounded                                            | Each run's key carries a token budget; the output limit of each call is capped to what is left, and calls are refused once it is spent   |
| Agents can't get around the network lockdown through the provider | Provider-side tools (web search/fetch, code execution, remote MCP) need the `llm:server-tools` permission                                |
| Members only see their own runs, schedules and outputs            | Member routes check ownership and answer 404 otherwise                                                                                   |
| No secrets in the database                                        | Keys and known token formats are redacted before activity, transcripts and prompts are written                                           |

## Internet access

A template can list HTTPS domains its agents may reach (**Internet access** in the template editor):

- `example.com` allows that host only.
- `*.example.com` allows its subdomains, but not `example.com` itself.

Keys snapshot the list when they are issued.

When the list isn't empty, the runner sets `HTTPS_PROXY` (and `HTTP_PROXY`) to the gateway, with
the session key as the password. `NO_PROXY` covers the gateway itself. curl, git, npm, pip, cargo
and most CLIs honor these variables. The VM firewall doesn't change: programs that ignore the
proxy settings get nowhere.

For each `CONNECT <domain>:443`, the gateway's VM listener:

1. checks the session key (`Proxy-Authorization`; `407` otherwise);
2. checks the domain against the key's list. Only port 443 is allowed, and IP addresses are refused;
3. resolves the name itself, and refuses it if **any** address is private, loopback, link-local,
   shared or reserved. This stops an allowed name from pointing at the host, the VM network or a
   cloud metadata service;
4. connects to a checked address (IPv4 first) and relays the bytes.

Each connection is logged with its domain, bytes and duration (tool `internet`), and shows up in
the run's gateway calls. A key holds at most 64 tunnels at once. Tunnels close after 5 minutes
idle and when the key expires.

Plain HTTP to other hosts is refused. Plain HTTP to the gateway itself (sent in absolute form by
clients that ignore `NO_PROXY`) is served as usual.

**What it doesn't do.** TLS is end to end, so the gateway sees the domain, never the requests:

- It can't allow only some paths or methods (e.g. GET only). Doing so would mean decrypting the
  traffic, with a gateway certificate installed in the VM. Some tools pin their certificates, and
  the gateway would become a much bigger target. Read-only methods wouldn't stop data from leaving
  either, because a URL can carry data.
- Every listed domain is a place an agent can send data to. Keep the lists short, and prefer
  package registries and documentation sites.

Domains of services the gateway brokers can't be listed, nor their subdomains: `github.com`,
`slack.com`, `monday.com`, `linear.app`, the model APIs, and so on. Direct access would bypass
their per-repository and per-permission checks and token budgets, so grant their tool instead.

**Known limitation (accepted for now):** the agent can read its own session key (environment
variable). It is scoped and short-lived, and it only works from inside the VM network.

## Setting up a host

`sudo deploy/install.sh` does all of this on a fresh Debian/Ubuntu host with KVM (see the README).
The manual steps it automates:

Requirements: Linux with KVM, root for the one-time setup, Docker to build the guest image, and
Node 22.

```bash
# 1. Host: Firecracker + jailer, the guest kernel, the jail user, the VM bridge and its firewall.
sudo deploy/vm-host-setup.sh            # re-run at boot (the vmd unit does it)

# 2. Guest image: Node 22, the agent CLIs, the runner bundle.
deploy/build-guest-image.sh rootfs.ext4
sudo install -m 0644 rootfs.ext4 /var/lib/launchpad/rootfs.ext4

# 3. vmd, the root VM daemon (deploy/install.sh writes a systemd unit for it).
npm run build
sudo VMD_SOCKET_GID=$(id -g) node dist/vmd/index.js

# 4. The gateway, with the launchpad on.
GATEWAY_VM_HOST=172.30.0.1 LAUNCHPAD_VM_DRIVER=firecracker npm start
```

Then, as admin:

1. Connect a model API key under **Accounts** (Anthropic, OpenAI or Gemini), or give the
   templates a **Custom LLM** endpoint (see [Custom LLM endpoints](#custom-llm-endpoints)).
2. Grant `llm:invoke` (plus a model allowlist) in the templates meant for agents. Give those
   templates a max TTL above the run time limit, which is 2 h by default.
3. Set limits under **Launchpad**.

### Configuration

| Variable                                                  | Default                        |                                                                    |
| --------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `LAUNCHPAD_VM_DRIVER`                                     | unset (launchpad off)          | `firecracker`, or `local-unsafe` for development                   |
| `GATEWAY_VM_HOST`                                         | unset                          | VM bridge IP the gateway also listens on (needed by `firecracker`) |
| `LAUNCHPAD_VMD_SOCKET`                                    | `/run/launchpad/vmd.sock`      |                                                                    |
| `LAUNCHPAD_RUNNER_SCRIPT`                                 | `guest/dist/runner.js`         | runner bundle used by `local-unsafe`                               |
| `VMD_SOCKET_GID`                                          | unset (root only)              | group allowed to use vmd's socket                                  |
| `VMD_STATE_DIR`                                           | `/var/lib/launchpad`           | `rootfs.ext4`, `vmlinux`, `logs/`, `images/`                       |
| `VMD_BRIDGE` / `VMD_BRIDGE_ADDRESS` / `VMD_PREFIX_LENGTH` | `lpbr0` / `172.30.0.1` / `24`  |                                                                    |
| `VMD_MAX_VMS`                                             | `32`                           | hard cap on VMs (the launchpad's own limits apply first)           |
| `VMD_JAIL_UID` / `VMD_JAIL_GID`                           | `900`                          | unprivileged user Firecracker runs as                              |
| `FIRECRACKER_BIN` / `JAILER_BIN`                          | `/usr/local/bin/…`             |                                                                    |
| `VMD_IMAGE_BUILD_SCRIPT`                                  | `deploy/build-custom-image.sh` | builds guest environments (`<Dockerfile> <output> <size>`)         |
| `VMD_IMAGE_SIZE`                                          | `6G`                           | size of a guest environment's rootfs                               |

Run limits are set in the UI (**Launchpad**):

- agents at once, in total and per member;
- the default and maximum time limit (2 h / 4 h);
- the token budget per run;
- vCPUs and memory per VM;
- how long output files are kept (30 days). Transcripts and gateway calls are kept.

Runs are never deleted: every run, with its prompt, transcript, gateway calls and token usage,
stays in the database for auditing, whatever its age and even after its schedule, trigger or
member is deleted. The runs list shows the newest 50; **Show older runs** pages back through the
rest (`GET …/runs?before=<createdAt>&beforeId=<id>`, the last run of the previous page, newest
first).

## Development without KVM

`LAUNCHPAD_VM_DRIVER=local-unsafe` runs the runner as a plain child process of the gateway, with
**no isolation** and the gateway user's privileges. `LAUNCHPAD_HARNESS_PATH` can point at a
directory of (fake) harness CLIs. The UI flags this driver in red.

The tests cover the lifecycle with a fake VM driver (`test/launchpadHelpers.ts`). An end-to-end
test runs the real runner bundle with a scripted CLI (`test/guestE2e.test.ts`). `vmd` is tested
against a fake host (`test/vmd.test.ts`).

## Harnesses

| Harness     | Model API                                                  | Gateway tools                     | Started as                                                                    |
| ----------- | ---------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| Claude Code | `ANTHROPIC_BASE_URL` → `/proxy/anthropic`                  | MCP (`--mcp-config`, stdio)       | `claude -p … --output-format stream-json --permission-mode bypassPermissions` |
| Codex       | `model_providers.gateway` → `/proxy/openai/v1` (Responses) | MCP (`-c mcp_servers.gateway…`)   | `codex exec --json --dangerously-bypass-approvals-and-sandbox`                |
| Gemini CLI  | `GOOGLE_GEMINI_BASE_URL` → `/proxy/gemini`                 | MCP (`~/.gemini/settings.json`)   | `gemini --output-format stream-json --approval-mode yolo`                     |
| pi          | `models.json` provider `baseUrl` → `/proxy/<provider>`     | pi extension (`pi-extension.mjs`) | `pi --mode json --no-session`                                                 |
| Script      | `LLM_URL` → `/proxy/custom`, if the template grants it     | HTTP: `$GATEWAY_URL/proxy/<tool>` | `node script.mjs`                                                             |

### Custom LLM endpoints

A template's **Custom LLM** endpoint (`/proxy/custom`) can run the harnesses that speak its chat
API:

| Chat API  | Harnesses                                                            |
| --------- | -------------------------------------------------------------------- |
| Anthropic | Claude Code (`ANTHROPIC_BASE_URL`), pi (`api: "anthropic-messages"`) |
| OpenAI    | Codex (Responses API, bridged), pi (`"openai-completions"`)          |

OpenAI-style endpoints only need Chat Completions, which every OpenAI-compatible server (vLLM,
Ollama, llama.cpp, LM Studio, LiteLLM…) speaks. Codex only speaks the Responses API, so the gateway
sends its `POST /v1/responses` calls to the endpoint as `POST /v1/chat/completions` and turns the
answers (streamed or not) back into Responses ones. Instructions, messages, images, function and
freeform tools and their calls, tool choice, structured output and usage carry over. Hosted tools
are refused (Codex runs with `web_search = "disabled"` on custom endpoints), Codex's sub-agent tool
namespace is left out, and reasoning is not handed back. Codex has no metadata (context window…)
for custom models: its warning about it shows as a status, not an error.

The gateway adds no output-token limit where the harness set none (Codex sets none): self-hosted
servers refuse limits beyond their context window, such as the run's whole token budget. The
budget is then checked between calls, and limits the harness did set are still capped to it.

The endpoint has no default model, so a launch names one. The default is the first exact model in
the template's allowlist; when the allowlist names none, the member picks one in the launch form.
The form proposes the models the endpoint itself lists: the gateway calls the endpoint's
`GET /v1/models` with its bearer token (`GET /api/me/launchpad/templates/<id>/models`) and keeps
those the template's allowlist covers. If the endpoint can't list them, the member types the model
in. Claude
Code's model aliases (Haiku/Sonnet/Opus, subagents) all map to that model. pi gets the endpoint as
its own `custom` provider; its key is read from `GATEWAY_SESSION_KEY` and is not written to disk.
When the template also grants an official model API the harness speaks, the harness uses that
API if the member has an account for it. A run's key never covers an endpoint whose chat API the
harness doesn't speak.

`test/customLlmHarnesses.test.ts` runs the real pi and Codex CLIs (pinned as devDependencies)
through the gateway on a fake Chat Completions endpoint: each runs a shell command and finishes
with the model's answer. Set `CUSTOM_LLM_URL`, `CUSTOM_LLM_TOKEN` and optionally
`CUSTOM_LLM_MODEL` to also run both against a real endpoint.

All four were run inside the guest image against the gateway. Each started with these flags and
sent its model calls through the gateway, which allowed them. Upstream then refused the test keys.

Amp and Antigravity use their own backends and can't be routed through the gateway, so they are
not supported.
