# Local Gateway: working notes

- TypeScript everywhere. Server: Express 5 (`src/server`, NodeNext ESM, `.js` import suffixes).
  UI: Next.js 16 App Router + Tailwind 4 (`web/`), served by the same Express process.
- **After every change run `npm run check`** (typecheck, ESLint strict-type-checked, Prettier check,
  Vitest). Fix everything before considering an iteration done. `npm run lint:fix` and
  `npm run format` autofix most issues.
- Application code (`src/server`, `web`) also follows the rules carried over from oyster: no magic
  numbers (use named constants, e.g. `src/server/units.ts`, `src/server/httpStatus.ts`,
  `web/lib/units.ts`), SonarJS duplication/complexity limits (cognitive ≤ 25, cyclomatic ≤ 15,
  nesting ≤ 4, no string literal repeated 3+ times). Split components/functions rather than
  disabling these rules.
- All cryptography goes through libsodium (`src/server/store/crypto.ts`). Never use `node:crypto`
  primitives directly or hand-roll constructions.
- Secrets (tool credentials) must never be returned by the API or logged. Admin tokens (`gwa_`),
  member keys (`gwm_`), session keys (`gws_`) and admin session cookies (`gwc_`) are stored only
  as keyed hashes. Member endpoints must only ever narrow what a member can reach (templates ∩
  accounts allowlists), and never expose other members' data.
- Proxy authorization is deny-by-default: new GitHub endpoints need an explicit rule in
  `src/server/tools/github.ts` plus a test in `test/github.test.ts`.
