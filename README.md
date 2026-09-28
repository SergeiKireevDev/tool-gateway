# Local Gateway

A local gateway that brokers **scoped, short-lived access** to third-party tools. You connect your
tool accounts once. You then hand scripts or agents a **session key**, which only allows what a
permission template allows and stops working when its TTL expires. The real credentials never
leave the gateway.

Supported tools: **GitHub** (REST API).

```
client ──(gws_… session key)──▶ gateway ──(your real token)──▶ api.github.com
                                  │
                                  ├─ checks the key is active (TTL, not revoked)
                                  ├─ checks method + path against the template's permissions
                                  └─ checks the repository against the template's allowlist
```

## Quick start

```bash
npm install
cp .env.example .env   # then fill in the Google variables (see below)
npm run dev            # http://localhost:7420
```

On first start the console prints an **admin token** (`gwa_…`). It is shown only once. You can
always sign in with it, and it is also how scripts call the admin API. If you lose it, stop the
gateway and run `npm run admin:reset-token`.

Production:

```bash
npm run build && npm start
```

## Admin sign-in with Google

1. In [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type **Web application**. Add this authorized redirect URI:
   `http://localhost:7420/auth/google/callback`. It must equal
   `<GATEWAY_PUBLIC_URL>/auth/google/callback`; the gateway prints the exact value on startup.
2. Fill in `.env`:
   ```bash
   GOOGLE_CLIENT_ID=….apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…
   GATEWAY_ADMIN_EMAILS=you@example.com,colleague@example.com   # the admin allowlist
   ```
3. Restart the gateway. `.env` is only read at startup; real environment variables override it.

Only verified Google accounts listed in `GATEWAY_ADMIN_EMAILS` can sign in, and anyone else is
refused. The login uses OpenID Connect (authorization code + PKCE, state and nonce) through
[`openid-client`](https://github.com/panva/openid-client). A successful sign-in creates a 12-hour
session held in an `HttpOnly`, `SameSite=Strict` cookie.

## Connecting GitHub

Go to **Accounts → Connect account**. There are two ways to connect:

- **Sign in with GitHub** (recommended). This uses GitHub's OAuth
  [device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow),
  so there is no client secret and no public callback URL.
  1. One-time setup: [register an OAuth App](https://github.com/settings/applications/new). The
     homepage and callback URL can be anything, for example `http://127.0.0.1:7420`. Tick
     **Enable Device Flow**, then paste the app's **Client ID** into the dialog.
  2. Enter a label and the scopes to request (default: `repo read:org`), then click
     **Sign in with GitHub**.
  3. Enter the code shown on github.com/login/device. The gateway picks up the token
     automatically, verifies it, and stores it encrypted.
- **Paste a token**: a fine-grained or classic personal access token.

## Concepts

| Concept         | What it is                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account**     | A tool credential (for example a GitHub personal access token). It is verified against the tool when connected, then stored encrypted.                                                                                                 |
| **Template**    | A named set of permissions (for example `issues:read` or `pulls:write`), plus a resource allowlist (`owner/repo` or `owner/*`) and a default and maximum TTL.                                                                          |
| **Session key** | A `gws_…` bearer key issued from a template and bound to one account. It stores a snapshot of the template's permissions, so editing the template later never widens live keys. Deleting the template or the account revokes its keys. |

GitHub permissions are mapped to explicit REST endpoint rules (see `src/server/tools/github.ts`).
Anything not covered by a rule is denied. That includes GraphQL, repository settings, webhooks,
Actions secrets, and deleting repositories. The gateway can never grant more than the underlying
token allows, so a fine-grained PAT is recommended.

## Using a session key

Issue a key in the UI (**Session keys → Issue session key**) and copy it. It is shown only once.

```bash
export GATEWAY_URL=http://127.0.0.1:7420/proxy/github
export GATEWAY_SESSION_KEY=gws_…

curl -H "Authorization: Bearer $GATEWAY_SESSION_KEY" $GATEWAY_URL/repos/octocat/Hello-World/issues
curl -H "Authorization: Bearer $GATEWAY_SESSION_KEY" http://127.0.0.1:7420/api/session   # introspect
```

With Octokit: `new Octokit({ auth: key, baseUrl: GATEWAY_URL })`. Pagination `Link` headers are
rewritten to point back at the gateway.

When the gateway denies a request, it answers `403` with an `x-gateway-denied: true` header and a
reason. Expired, revoked or unknown keys get `401`.

## Members: self-serve session keys

A **member key** (`gwm_…`) lets a script, agent or CI job request its own session keys, so no
admin has to issue each one. Create members in **Members → New member**:

- choose the **templates** it may request keys from, and the **accounts** those keys may use;
  everything else is denied
- optionally make the member key expire (30 days, 90 days, 1 year)
- the member key is shown once; **Rotate key** replaces it and revokes the session keys it issued,
  **Delete** does the same and removes the member

A member key cannot call tools or the admin API: it can only obtain session keys.

| Endpoint (with `Authorization: Bearer gwm_…`) | Purpose                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/member`                             | The templates and accounts this member may use                         |
| `POST /api/sessions`                          | Issue a session key: `{ templateId, accountId?, ttlSeconds?, label? }` |
| `GET /api/sessions`                           | Session keys this member issued                                        |
| `POST /api/sessions/:id/revoke`               | Revoke one of them                                                     |

```bash
curl -X POST https://gateway.example/api/sessions \
  -H "Authorization: Bearer $GATEWAY_MEMBER_KEY" -H 'Content-Type: application/json' \
  -d '{"templateId":"<template id>","ttlSeconds":1800,"label":"nightly triage"}'
# → 201 { "key": "gws_…", "session": { …, "issuedBy": { "kind": "member", … } } }
```

`accountId` can be omitted when the member is allowed exactly one account for the template's tool.
TTLs follow the template's default and maximum. Templates or accounts outside the member's
allowlists get `403` (whether or not they exist). The admin UI shows which member issued each
session key, and the Activity tab logs member actions.

## Security model

- **Cryptography** is done entirely with [libsodium](https://doc.libsodium.org/)
  (`libsodium-wrappers`):
  - A 256-bit master key goes through `crypto_kdf` to derive separate subkeys for storage and for
    token hashing.
  - The store is encrypted with XChaCha20-Poly1305 (IETF AEAD) under a random 192-bit nonce on each
    write.
  - Admin tokens and session keys are stored only as keyed BLAKE2b hashes and compared in constant
    time.
- **Master key**: `~/.local-gateway/master.key` (mode `0600`, directory `0700`). It is kept
  separate from the data directory on purpose. Back it up: without it the store cannot be decrypted.
- **Store**: `./data/store.enc` (mode `0600`). It is written atomically. The gateway refuses to
  start if the file cannot be authenticated.
- **Admin auth**: the admin API accepts either the admin token (`Authorization` header) or a Google
  sign-in session cookie. Cookie-authenticated calls must also send `x-gateway-request: 1`.
  Cross-site pages can't add that header without a CORS preflight, which the gateway never grants.
  On top of `SameSite=Strict`, this blocks CSRF. Session cookies are stored as keyed hashes only.
- **Keys**: admin tokens (`gwa_`), member keys (`gwm_`), session keys (`gws_`) and admin session
  cookies (`gwc_`) all have distinct prefixes, are only accepted where they belong, and are stored
  as keyed hashes only.
- **Network**: the gateway binds to `127.0.0.1` by default. UI responses set
  `X-Frame-Options: DENY`.
- **Proxy hardening**:
  - Request paths are validated raw: dot segments, encoded slashes and empty segments are rejected.
  - Only an allowlist of request headers is forwarded, and the client's `Authorization` header is
    replaced.
  - Redirects are not followed, and `Set-Cookie` headers are stripped.

Limitations for now:

- Anyone who can read both the key file and the store as your OS user can decrypt them. Moving the
  master key to the OS keychain is a natural next step.
- The activity log is kept in memory.

## Configuration

| Variable               | Default                               |
| ---------------------- | ------------------------------------- |
| `GATEWAY_HOST`         | `127.0.0.1`                           |
| `GATEWAY_PORT`         | `7420`                                |
| `GATEWAY_DATA_DIR`     | `./data`                              |
| `GATEWAY_KEY_FILE`     | `~/.local-gateway/master.key`         |
| `GATEWAY_PUBLIC_URL`   | `http://<host>:<port>`                |
| `GOOGLE_CLIENT_ID`     | unset (Google sign-in off)            |
| `GOOGLE_CLIENT_SECRET` | unset                                 |
| `GATEWAY_ADMIN_EMAILS` | empty (nobody can use Google sign-in) |

Variables are read from `.env` in the working directory (see `.env.example`), then overridden by
the real environment.

## Development

| Script             | What it does                                                                      |
| ------------------ | --------------------------------------------------------------------------------- |
| `npm run dev`      | Express + Next.js dev server on a single port (restarts when server code changes) |
| `npm run check`    | **typecheck + ESLint + Prettier check + tests**. Run this after every change.     |
| `npm run lint:fix` | Autofix lint issues                                                               |
| `npm run format`   | Format with Prettier                                                              |
| `npm test`         | Vitest suite. `test/github.live.test.ts` calls the real api.github.com.           |

For the full live proxy test, set `GITHUB_TOKEN` (and optionally `GITHUB_TEST_REPO=owner/repo`).
Without it, only the "real GitHub rejects bad tokens" check runs.

Layout:

```
src/server/          Express server: admin API, proxy, gateway logic
  store/             libsodium crypto + encrypted store
  tools/             tool providers (github.ts) and path matching
  http/              Express app, proxy handler
web/                 Next.js 16 (App Router) + Tailwind CSS 4 admin UI
test/                Vitest (unit, API/proxy e2e, live GitHub)
```

Adding a tool: implement `ToolProvider` (`src/server/tools/types.ts`) and register it in
`src/server/bootstrap.ts`. The UI picks up its permissions and help texts automatically.
