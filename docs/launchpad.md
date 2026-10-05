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
   CLI or pi), and "now" or a schedule. The launchpad checks the following, then queues the run:
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

## Guarantees and where they come from

| Guarantee                                                         | Mechanism                                                                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| An agent can do no more than its member could                     | Keys are issued in-process with the member-key narrowing, re-checked inside the store mutation (`gateway.issueSessionForRun`)            |
| Keys and VMs never outlive their run                              | `Launchpad.finish` revokes and destroys; the reaper runs every minute; the key TTL is the run time limit + 5 min                         |
| VMs reach the gateway only                                        | `deploy/vm-host-setup.sh`: nftables drops forwarding off the bridge and all host ports but the gateway's; taps are isolated bridge ports |
| The VM listener exposes nothing else                              | `createVmApp` serves only `/proxy/*`, `/api/session` and `/runner/*`                                                                     |
| The model API key never enters the VM                             | LLM providers (`src/server/tools/llm`) swap the session key for the real key; their auth errors are not relayed                          |
| Model spend is bounded                                            | Each run's key carries a token budget; the output limit of each call is capped to what is left, and calls are refused once it is spent   |
| Agents can't get around the network lockdown through the provider | Provider-side tools (web search/fetch, code execution, remote MCP) need the `llm:server-tools` permission                                |
| Members only see their own runs, schedules and outputs            | Member routes check ownership and answer 404 otherwise                                                                                   |
| No secrets in the database                                        | Keys and known token formats are redacted before activity, transcripts and prompts are written                                           |

**Known limitation (accepted for now):** the agent can read its own session key (environment
variable). It is scoped and short-lived, and it only works from inside the VM network.

## Setting up a host

Requirements: Linux with KVM, root for the one-time setup, Docker to build the guest image, and
Node 22.

```bash
# 1. Host: Firecracker + jailer, the guest kernel, the jail user, the VM bridge and its firewall.
sudo deploy/vm-host-setup.sh            # re-run at boot (the vmd unit does it)

# 2. Guest image: Node 22, the agent CLIs, the runner bundle.
deploy/build-guest-image.sh rootfs.ext4
sudo install -m 0644 rootfs.ext4 /var/lib/launchpad/rootfs.ext4

# 3. vmd, the root VM daemon (see deploy/launchpad-vmd.service).
npm run build
sudo VMD_SOCKET_GID=$(id -g) node dist/vmd/index.js

# 4. The gateway, with the launchpad on.
GATEWAY_VM_HOST=172.30.0.1 LAUNCHPAD_VM_DRIVER=firecracker npm start
```

Then, as admin:

1. Connect a model API key under **Accounts** (Anthropic, OpenAI or Gemini).
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

All four were run inside the guest image against the gateway. Each started with these flags and
sent its model calls through the gateway, which allowed them. Upstream then refused the test keys.

Amp and Antigravity use their own backends and can't be routed through the gateway, so they are
not supported.
