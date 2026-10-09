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
   CLI or pi), and "now", a schedule or a webhook trigger. The launchpad checks the following, then queues the run:
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

4. **Finish.** The runner uploads `/home/agent/out` and `MEMORY.md`, then reports the result. The
   launchpad then **always** revokes the key and destroys the VM. A reaper does the same for runs
   whose VM died, that passed their deadline, or that were left by a gateway restart. It also
   destroys VMs that no run owns.

Scheduled agents use Hourly, Daily, Weekly or Monthly presets in the member's time zone:

- A run is skipped while the previous one is still going.
- Each successful run's `MEMORY.md` is given to the next run.
- A schedule **stops** when its member's key is rotated or revoked, or when the member is deleted
  or expired. The member can resume it; the admin can pause it.

## Webhook triggers

A trigger launches an agent for each accepted delivery on one of the member's own
[webhooks](../README.md#webhooks) (**New agent → On a webhook event**, or
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
  trigger is created and resumed, and again on each launch. Only the member's own webhooks can
  trigger their agents.
- **Limits.** A trigger has at most 3 runs queued or running; further deliveries are skipped (and
  logged in Activity). The usual concurrency limits and token budget apply to each run.
- **Stopping.** Like schedules, a trigger stops when its member's key is rotated or revoked, when the
  member is deleted or expired, or when a launch fails. The member can resume it; the admin can
  pause it. Deleting the webhook leaves the trigger without events.

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

| Variable                                                  | Default                       |                                                                    |
| --------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `LAUNCHPAD_VM_DRIVER`                                     | unset (launchpad off)         | `firecracker`, or `local-unsafe` for development                   |
| `GATEWAY_VM_HOST`                                         | unset                         | VM bridge IP the gateway also listens on (needed by `firecracker`) |
| `LAUNCHPAD_VMD_SOCKET`                                    | `/run/launchpad/vmd.sock`     |                                                                    |
| `LAUNCHPAD_RUNNER_SCRIPT`                                 | `guest/dist/runner.js`        | runner bundle used by `local-unsafe`                               |
| `VMD_SOCKET_GID`                                          | unset (root only)             | group allowed to use vmd's socket                                  |
| `VMD_STATE_DIR`                                           | `/var/lib/launchpad`          | `rootfs.ext4`, `vmlinux`, `logs/`                                  |
| `VMD_BRIDGE` / `VMD_BRIDGE_ADDRESS` / `VMD_PREFIX_LENGTH` | `lpbr0` / `172.30.0.1` / `24` |                                                                    |
| `VMD_MAX_VMS`                                             | `32`                          | hard cap on VMs (the launchpad's own limits apply first)           |
| `VMD_JAIL_UID` / `VMD_JAIL_GID`                           | `900`                         | unprivileged user Firecracker runs as                              |
| `FIRECRACKER_BIN` / `JAILER_BIN`                          | `/usr/local/bin/…`            |                                                                    |

Run limits are set in the UI (**Launchpad**):

- agents at once, in total and per member;
- the default and maximum time limit (2 h / 4 h);
- the token budget per run;
- vCPUs and memory per VM;
- how long output files are kept (30 days). Transcripts and gateway calls are kept.

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

### Custom LLM endpoints

A template's **Custom LLM** endpoint (`/proxy/custom`) can run the harnesses that speak its chat
API:

| Chat API  | Harnesses                                                                          |
| --------- | ---------------------------------------------------------------------------------- |
| Anthropic | Claude Code (`ANTHROPIC_BASE_URL`), pi (`api: "anthropic-messages"`)               |
| OpenAI    | Codex (needs the endpoint to serve the Responses API), pi (`"openai-completions"`) |

The endpoint has no default model, so a launch names one. The default is the first exact model in
the template's allowlist; when the allowlist names none, the member types the model in. Claude
Code's model aliases (Haiku/Sonnet/Opus, subagents) all map to that model. pi gets the endpoint as
its own `custom` provider; its key is read from `GATEWAY_SESSION_KEY` and is not written to disk.
When the template also grants an official model API the harness speaks, the harness uses that
API if the member has an account for it. A run's key never covers an endpoint whose chat API the
harness doesn't speak.

All four were run inside the guest image against the gateway. Each started with these flags and
sent its model calls through the gateway, which allowed them. Upstream then refused the test keys.

Amp and Antigravity use their own backends and can't be routed through the gateway, so they are
not supported.
