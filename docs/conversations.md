# Duplex conversations, explained

This is a walkthrough of how a launchpad agent can hold a two-way exchange with a third party (a
Linear issue's comments, a GitHub pull request's reviews, a chat thread…): what problem it
solves, how the pieces fit, and what happens at each step. The reference (every field, endpoint
and limit) is in [Agent launchpad → Conversations](launchpad.md#conversations). This page explains
the reasoning behind it.

## The problem

A plain [webhook trigger](launchpad.md#webhook-triggers) is one-way and stateless. Each delivery
launches a fresh agent that knows nothing of earlier deliveries. That works for "label every new
issue", but not for an exchange:

```
human: "Can you add a retry to the upload?"      → agent A starts, opens a PR, exits
human: "Thanks, but make it 3 retries, not 5."   → agent B starts, knows nothing of A or its PR
```

Agent B has to rediscover everything, and two agents may run at once on the same thread and
step on each other. A conversation trigger fixes this. Deliveries that belong to the same thread
become the **messages of one conversation**. **One agent at a time** serves it, hears the new
messages **while it runs**, and when it has finished, the next message **revives** the
conversation in a new run that starts from its history and memory.

## The two directions

"Duplex" means both directions are open at the same time while an agent runs. They take
different paths:

```
                     third party (Linear, GitHub, Slack…)
                       │                               ▲
           webhook     │                               │  the agent answers with its tools
           delivery    ▼                               │  (/proxy/linear, /proxy/github…)
   ┌────────────────────────────────────────────────────────────────────────┐
   │ gateway          IN                                OUT                 │
   │   webhook ─▶ trigger ─▶ channel                   proxy ◀── template ∩ │
   │                          │ sources, event types,    ▲       accounts   │
   │                          │ filters, key expression  │                  │
   │                          ▼                          │                  │
   │                  conversation (key) ── messages ─┐  │                  │
   │                          │  in / out             │  │                  │
   │       no agent serving?  │                       │  │                  │
   │       launch a run ──────┘      /api/session/conversation              │
   │                                  GET  /         what am I serving?     │
   │                                  POST /receive  long-poll, up to 50 s  │
   │                                  POST /reply    record an out message  │
   └──────────────────────────────────────────▲──────┼──▲───────────────────┘
                                              │      ▼  │
                         microVM: runner ─ MCP server / pi extension ─ agent
                                  gateway_conversation_receive  gateway_conversation_reply
```

- **In (third party → agent).** The third party's webhook reaches the gateway. The trigger's
  conversation channel decides whether the delivery belongs to a conversation and to which one.
  The delivery is stored as an `in` message. The agent gets it, either as the task of the run it
  starts or through `gateway_conversation_receive` while it runs.
- **Out (agent → third party).** The agent answers **where the conversation happens, with its
  ordinary tools**: a Linear comment through `/proxy/linear`, a PR review through
  `/proxy/github`. These calls are scoped by the run's template and accounts like any other.
  `gateway_conversation_reply` does **not** reach the third party. It only records an `out`
  message in the conversation's transcript, for the member to read and for later runs to see in
  their history.

The gateway never posts to the third party for the agent. This keeps the outbound side under
the same deny-by-default proxy rules as every other agent call: a conversation adds no new way
to write anywhere.

## Who sets what

| Piece                    | Who     | Decides                                                                                                                                 |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook                  | member  | Where deliveries come from (the member's own, or one the admin shares)                                                                  |
| **Conversation channel** | admin   | Which deliveries are messages (`sources`, `eventTypes`, `filters`), how they're keyed (`conversationKey`), the agents' template and TTL |
| Conversation trigger     | member  | Webhook + channel, `instructions`, harness and model, the accounts the agents use                                                       |
| Conversation             | gateway | One per distinct key of a trigger, opened on its first message                                                                          |
| Run                      | gateway | At most one active per conversation                                                                                                     |

Channels belong to the admin because a conversation's agent hears whoever can post to the
source, and it lives on across runs. Picking which deliveries count, and how long the agents
live, is a policy decision. Accounts belong to the member, as with any launch. For a bot
identity, the admin creates a member for the bot and creates the triggers as that member.

## A conversation's life, step by step

Example: a channel on Linear comments, `eventTypes: ["Comment.create"]`,
`conversationKey: ".data.issueId"`.

```
 t   third party            gateway                                     agent (run)
 ─   ──────────────         ─────────────────────────────────────────   ─────────────────────────
 1   comment #1 on SER-7 ─▶ key "SER-7-id" → open conversation C
                            in #1 (pending)
                            nobody serves C → launch run R1
                            task = [#1], in #1 given to R1 ─────────▶  starts, reads task (#1)
 2                                                                      comments on SER-7 via
                         ◀─────────────────────────────────── /proxy ─  /proxy/linear
 3                                                                      receive(waitSeconds=120)
                                                                        └─ POST /receive (≤50 s)…
 4   comment #2 on SER-7 ─▶ in #2 → wakes R1's waiting receive ───────▶ "1 new event(s)…" (#2)
 5                                                                      handles #2, reply(...)
                            out "Changed retries to 3" (R1) ◀────────── POST /reply
 6                                                                      receive → none in 120 s
                                                                        writes MEMORY.md, exits
 7                          R1 finished: memory kept for C,
                            final message → out (R1)
                            nothing pending → C sleeps
     … hours later …
 8   comment #3 on SER-7 ─▶ in #3 → nobody serves C → launch run R2
                            MEMORY.md = C's memory,
                            system prompt = C's history (#1, #2, R1's out messages),
                            task = [#3] ────────────────────────────▶  picks up where R1 left off
```

Step by step:

1. **Keying.** The delivery passes the channel's sources, event types and filters. Then the
   channel's key expression (a jq subset, see [the reference](launchpad.md#conversations)) runs
   on the redacted payload. Equal keys mean the same conversation. A payload that gives no key
   (null, an error, longer than 200 characters) is skipped and logged in Activity.
2. **Storing.** The delivery becomes an `in` message (the same text a plain trigger's task would
   be: event type, webhook, payload as JSON). Every message is stored before anything else
   happens, so no delivery of a conversation is ever dropped.
3. **Serving.** If an active (queued or running) run already serves the conversation, the
   message waits for it. Otherwise the gateway launches a run whose task is the pending messages
   (as many as fit in a prompt; the others wait for the agent to ask) and marks them as given to
   it.
4. **Receiving.** `gateway_conversation_receive` is a long poll. The gateway's
   `POST /receive` gives the run every pending message, or parks the request (at most 50 s) until
   an `in` message is added to the conversation, which wakes it at once. The tool repeats the
   request until its own `waitSeconds` (up to 300) runs out, so the agent can wait five minutes
   with one tool call. The runner raises Codex's MCP tool timeout to allow it (its default of
   60 s would cut the wait off).
5. **Replying.** The agent acts through the proxy, then optionally records what it did with
   `gateway_conversation_reply`.
6. **Finishing.** The system prompt asks the agent to wait for more events while the exchange
   goes on, then to **finish**. It doesn't need to stay until its deadline: an idle agent holds a
   VM and a slot of the trigger, and waking it costs only a new run.
7. **Remembering.** When the run ends, its `MEMORY.md` (if any) is kept for the conversation and
   its final message becomes an `out` message. If messages arrived that the agent never asked
   for, a new run starts right away. Otherwise the conversation sleeps.
8. **Reviving.** The next message launches a new run with the conversation's `MEMORY.md` and,
   in its system prompt, the conversation's earlier messages (the latest 20,000 characters, each
   clipped to 4,000), marked as third-party data.

## State

Everything is in two tables. Nothing lives in the VM between runs except what comes back as
`MEMORY.md`.

```
conversations          id, trigger_id, member_id, key (unique per trigger),
                       memory (last MEMORY.md), run_id (serving now / last), runs
conversation_messages  id, conversation_id, at, direction (in|out),
                       event_id (in: the webhook event), run_id, text
```

A message's `run_id` carries the delivery state:

| direction | `run_id` | meaning                                                    |
| --------- | -------- | ---------------------------------------------------------- |
| `in`      | null     | pending: no run has it yet (counted as "messages waiting") |
| `in`      | set      | given to that run, as its task or through `receive`        |
| `out`     | set      | written by that run: a `reply`, or its final message       |

A message is given to exactly one run, and never twice. A run that crashes after receiving a
message doesn't give it back. Its successor sees it in the history, not as new.

## Concurrency and back-pressure

- **One run per conversation.** This is the invariant that makes duplex work: a new message
  either goes to the agent that already serves the conversation or starts the only one.
- **At most 3 active runs per trigger**, across all its conversations. A plain trigger skips
  deliveries above that. A conversation trigger queues them instead. Waiting conversations are
  served longest-waiting first, as the trigger's runs end.
- **Long-lived agents.** A channel's `agentTtlSeconds` (5 min – 24 h, capped by its template's
  key TTL) replaces the launchpad's default timeout, so an agent can hold a long session. The
  usual token budget still applies.

## Trust boundaries

- **Inbound is data.** Every message comes from whoever can post to the source. The task, the
  `receive` results and the revived history are all labelled as third-party data, not
  instructions, and payloads are redacted before they are stored.
- **The agent's side is narrow.** `/api/session/conversation` authenticates with the run's
  session key and only ever serves that run's own conversation, while the run is active. Other
  runs get 404, so their agents don't get the tools at all.
- **Outbound is the proxy's.** Replies to the third party are ordinary tool calls, under the
  run's template ∩ accounts.
- **Forgetting is immediate.** Deleting a conversation removes its history and memory, wakes a
  waiting `receive` with nothing, and makes the serving run's conversation tools return 404. The
  next delivery with the same key starts a new conversation.

## Designing a channel: pitfalls

- **Your own replies come back.** An agent that answers with a Linear comment triggers a
  `Comment.create` delivery on the same issue: its own message arrives as an `in` message. That
  wakes it, or revives the conversation after it has exited. Either tell the agent (in the
  trigger's `instructions`) to ignore events by its own account, or drop them in the key
  expression. A payload that gives no key opens nothing:

  ```
  select(.actor.id != "<bot user id>") | .data.issueId
  ```

- **Pick the notification types.** Without `eventTypes`, every update of an issue (labels,
  priority, the agent's own state changes) is a message. `["Comment.create"]` keeps the
  conversation to what people say.
- **Key on the thread, not the event.** The key must be the same for every event of the
  exchange and different across exchanges. For GitHub, a pull request's reviews and comments
  arrive with `.pull_request` or `.issue`, so combine them:
  `[.repository.full_name, (.pull_request.number // .issue.number)]`, which gives `["o/r",42]`.
- **Editing the key splits history.** Conversations keep the key they were opened with. After
  you change a channel's key (or a trigger's channel), the next deliveries open new
  conversations.
- **Ask agents to keep `MEMORY.md` short and current.** It is the only state a revived run gets
  besides the clipped history: open questions, the PR it opened, what was agreed.

## Where it lives in the code

| Concern                                       | File                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Channels (admin CRUD, `carries`)              | `src/server/launchpad/channels.ts`                                                  |
| Key expressions (jq subset)                   | `src/server/launchpad/payloadQuery.ts`                                              |
| Conversations, messages, long-poll waiters    | `src/server/launchpad/conversations.ts`                                             |
| Delivery → conversation → run, revival, drain | `src/server/launchpad/triggers.ts` (`converse`, `drain`, `revive`, `onRunFinished`) |
| `/api/session/conversation` routes            | `src/server/launchpad/routes.ts` (`conversationSessionRoutes`)                      |
| The agent's prompt section                    | `src/server/launchpad/systemPrompt.ts` (`conversationSection`)                      |
| The agent's tools (MCP / pi)                  | `src/guest/conversationTools.ts`, `src/guest/harnesses.ts` (tool timeouts)          |
