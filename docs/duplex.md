# Duplex mode: conversations with agents (design)

Status: **design**, tracked in SER-12. Only the lane routing (`src/server/launchpad/lanes.ts`) is
implemented so far; everything else here is the plan.

## Why

Today a [webhook trigger](launchpad.md#webhook-triggers) is one-way: a delivery launches an agent,
the agent acts, and the run ends. Sometimes we want to talk with an assistant **before** it starts
a unit of work: ask questions, refine the scope, agree on the approach. The agent must then be
reachable where the discussion started (a Linear issue, a GitHub issue or pull request, a
monday.com item) and answer there.

## What the member sees

1. A trigger gets a **mode**: `task` (today's behavior) or `conversation`.
2. In `conversation` mode, a delivery that passes the trigger's event types and filters **opens a
   conversation** on its unit of work (its _lane_, below). The agent reads the event and answers
   on the platform (a comment) instead of doing the work.
3. Each later comment in the same lane is a new **turn**: the agent gets the new messages with the
   conversation so far, and answers again.
4. When the discussion has converged ("go ahead"), the agent does the work in a turn, with the
   trigger's permissions, like a task run. The trigger's instructions say when to act.
5. The conversation **closes** when the unit of work is closed (issue done or canceled, pull
   request merged or closed), after a period without messages (7 days), after a maximum number of
   turns (50), or when the member closes it in the UI.

## Lanes: which agent hears which comment

Comments on unrelated units of work must never reach the same agent. The gateway decides this
**deterministically, from the payload** (never with a model), before anything is launched:

- `laneOf(source, payload)` gives the delivery's lane key, or null when the delivery isn't about
  one unit of work:

  | Source     | Lane                                    | Same lane                                                              |
  | ---------- | --------------------------------------- | ---------------------------------------------------------------------- |
  | Linear     | `linear:issue:<issue id>`               | `Issue.*` events and `Comment.*` events on that issue (`data.issueId`) |
  | GitHub     | `github:<owner>/<repo>#<number>`        | the issue or pull request, its comments, reviews and review comments   |
  | GitHub     | `github:<owner>/<repo>/discussions/<n>` | the discussion and its comments                                        |
  | monday.com | `monday:<board id>:<item id>`           | the item's column changes and its updates (comments), by `pulseId`     |
  | generic    | none                                    | no lanes: a `conversation` trigger can't be put on a generic webhook   |

- A conversation belongs to **one trigger and one lane**: `(trigger_id, lane_key)` is unique among
  open conversations. Two triggers on the same webhook keep separate conversations, and so do two
  issues on the same trigger.
- Routing a delivery for a `conversation` trigger:
  1. No lane → ignored (logged in Activity).
  2. An open conversation in the lane → the delivery is a **message** if it is a comment (Linear
     `Comment.create`, GitHub `issue_comment.created`, `pull_request_review.submitted`,
     `pull_request_review_comment.created`, `discussion_comment.created`, monday.com
     `create_update`), or a **close** if it closes the unit of work; anything else is ignored. The
     trigger's event types and filters only decide **opening**, so they don't have to list
     comment events.
  3. No open conversation → the trigger's event types and filters decide whether one **opens**.
     A trigger has at most 10 open conversations; beyond that, deliveries are skipped (Activity).

### The agent's own comments

The agent answers through the gateway with the trigger's tool account, so its replies come back
as deliveries. `actorsOf(source, payload)` reads who caused the event (Linear `actor` / `userId`,
GitHub `sender`, monday.com `event.userId`) and `causedBy(actors, identity)` compares them with the
`userId` / `login` identity the gateway recorded when the account was connected. Such deliveries
are dropped, so an agent never wakes itself up. The turn limit is the backstop.

### Who may talk to the agent

In conversation mode a comment is an instruction, not just data. Anyone who can comment on the
unit of work (on a public GitHub repository: anyone) could otherwise steer the agent within the
trigger's permissions. So a `conversation` trigger has a **participants** list (ids, logins or
emails, matched like `assignedTo`), by default the identities of the member's own accounts.
Comments from others are kept in the conversation's history as context, marked as third-party
data, but don't start a turn. The system prompt says so.

## Turns

A turn is a regular launchpad run (`runs.conversation_id` set): its own session key, VM, token
budget and time limit, revoked and destroyed at the end. All the [guarantees](launchpad.md#guarantees-and-where-they-come-from)
hold unchanged, and nothing stays alive between turns.

- **One turn at a time per conversation.** Messages that arrive during a turn are queued
  (`conversation_messages.status = pending`) and the next turn gets them all at once.
- **Prompt.** The system prompt gets the trigger's instructions plus a conversation section: the
  lane (`SER-12`), how to answer (post a comment on it with the gateway tool), that the agent
  should discuss rather than act until asked to, and that the run ends after the reply. The task
  is the conversation: the opening event, then each message (author, time, text) and each of the
  agent's previous replies (the runs' final messages), capped to the prompt size, oldest first
  dropped.
- **Continuity.** Phase 1 replays the conversation as above: it works the same for every harness.
  Phase 3 adds harness sessions: the runner uploads the harness's session directory at the end of
  a turn (Claude Code `~/.claude/projects`, Codex `~/.codex/sessions`, Gemini CLI `~/.gemini/tmp`,
  pi's session file), the gateway stores it with the conversation (size-capped, redacted like
  transcripts) and the next turn restores it and resumes (`claude --resume`, `codex exec resume`,
  `gemini --resume`, `pi --session`); only the new messages are then sent. The exact flags must
  be checked in the guest image, like the current ones were.
- **Memory.** `MEMORY.md` is carried from turn to turn like for schedules, for notes the agent
  wants to keep (e.g. the agreed plan).
- **Spend.** Each turn has the run's token budget; a conversation also has a total budget (turn
  budget × 10 by default). Past it, the conversation closes with a final reply-less note in
  Activity.

### Why not keep the VM alive

A live VM per conversation would answer faster and keep its working files, but conversations last
hours or days: the session key would need a long TTL (today: the run's limit + 5 min), VMs would
sit idle against the concurrency limits, and the reaper's "nothing outlives its run" guarantee
would no longer hold. A turn boots in seconds, which is fine at the pace of comments. Phase 4 can
add a short **warm window** (the runner long-polls `/runner/inbox` for a few minutes after a reply
and runs the next turn in the same VM, within the run's deadline) if replies feel slow.

## Data model

```sql
ALTER TABLE triggers ADD COLUMN mode TEXT NOT NULL DEFAULT 'task';      -- 'task' | 'conversation'
ALTER TABLE triggers ADD COLUMN participants TEXT NOT NULL DEFAULT '[]';

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  lane_key TEXT NOT NULL,
  lane_label TEXT NOT NULL,
  status TEXT NOT NULL,              -- 'open' | 'closed'
  closed_reason TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  memory TEXT,
  harness_session BLOB,              -- phase 3
  last_run_id TEXT,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);
CREATE UNIQUE INDEX conversations_open_lane ON conversations (trigger_id, lane_key)
  WHERE status = 'open';

CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,         -- the webhook delivery
  author TEXT NOT NULL,
  participant INTEGER NOT NULL,      -- 0: third-party context only
  text TEXT NOT NULL,                -- redacted, size-capped
  status TEXT NOT NULL,              -- 'pending' | 'delivered'
  run_id TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE runs ADD COLUMN conversation_id TEXT;
```

Conversations stop like their trigger: when the member's key is rotated or revoked, the member is
gone, or the trigger is paused or deleted, open conversations close.

## API and UI

- `POST/PATCH /api/me/launchpad/triggers` take `mode` and `participants`.
- `GET /api/me/launchpad/conversations` (own only; admin sees all), `GET …/:id` (messages and turn
  runs), `POST …/:id/close`.
- The trigger form gets a "Discuss before acting" switch and the participants field. The runs
  workspace groups a conversation's turns under it, with the thread.

## Plan

1. **Lanes** (done): `laneOf`, `actorsOf`, `causedBy`, with tests.
2. **Conversations**: migration, `Conversations` store, routing in `Triggers.onDelivery`, turn
   runs with the replayed thread, conversation system prompt, limits and closing, API.
3. **UI**: trigger mode and participants, conversation view.
4. **Harness sessions**: runner upload/restore of the harness session, resume flags per harness.
5. **Warm window** (if needed): `/runner/inbox`, next turn in the same VM.
