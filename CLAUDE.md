# Local Gateway: working notes

- TypeScript everywhere. Server: Express 5 (`src/server`, NodeNext ESM, `.js` import suffixes).
  UI: Next.js 16 App Router + Tailwind 4 (`web/`), served by the same Express process.
- **After every change run `npm run check`** (typecheck, ESLint strict-type-checked, Prettier check,
  Vitest). Fix everything before considering an iteration done. `npm run lint:fix` and
  `npm run format` autofix most issues.
- All cryptography goes through libsodium (`src/server/store/crypto.ts`). Never use `node:crypto`
  primitives directly or hand-roll constructions.
- Secrets (tool credentials) must never be returned by the API or logged. Session keys and admin
  tokens are stored only as keyed hashes.
- Proxy authorization is deny-by-default: new GitHub endpoints need an explicit rule in
  `src/server/tools/github.ts` plus a test in `test/github.test.ts`.
