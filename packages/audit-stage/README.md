# @kampus/audit-stage

The ephemeral **rite-audit stage lifecycle** — one command that provisions an isolated
audit stage, prepares it, mints a login-able test-mod, runs the audit hook, and tears the
stage down, with **teardown guaranteed on every exit path** (issue #1512, epic
[#1510](https://github.com/kamp-us/phoenix/issues/1510)).

The audit stage deploys on the dedicated `audit` deploy class (ADR 0088), so #1511's
force-on rule makes `phoenix-authorship-loop` active there — and **never** in production.
A live flag-on stage is exactly what a failed run must never leave behind, which is why
teardown is the load-bearing property.

## The five phases

1. **Deploy** a fresh isolated stage via `alchemy deploy --stage <stage>` on the `audit`
   environment (`ENVIRONMENT=audit`). Alchemy applies the worker `migrationsDir` during
   deploy (`apps/web/worker/db/resources.ts`), so this single step **provisions and
   migrates** the stage D1 — the "migrate" step is a sub-phase of deploy in this
   architecture, not a separate command.
2. **Preview-seed** the stage D1 with `@kampus/preview-seed` so the unauthenticated read
   surfaces have a baseline corpus.
3. **Mint a test-mod**: register a fresh çaylak via better-auth's no-verify auto-sign-in
   path (`POST /api/auth/sign-up/email`, the same path the e2e `signUpViaApi` helper
   drives), resolve the new `user.id` from the stage D1, then promote it to
   `moderator` + `yazar` + the `(id,"moderates","platform:platform")` tuple via
   `@kampus/founder-seed` — the minted id supplied as the cohort **data**, never hardcoded.
   The result is a login-able mod that can drive the divan vouch/promote.
4. **Run hook** — the audit-run seam (filled by #1513); a no-op in this issue.
5. **Destroy** the stage via `alchemy destroy --stage <stage>`.

## The safety core

The orchestration is a **pure core** (`src/lifecycle.ts`): a single `Effect` over an
injected `StageLifecyclePort` holding only the phase sequence and the teardown guarantee.
Teardown runs on **every** exit via `Effect.onExit`, and `destroy` is keyed on the stage
**name** alone — so even a deploy that failed mid-provision is still torn down. A failed
teardown surfaces loudly in the error channel rather than being swallowed.

Because the side effects live behind the port, the safety property is unit-tested against
an **in-memory fake** with no real deploy (`src/lifecycle.unit.test.ts`): the suite asserts
that a deliberately-failed run — at deploy, preview-seed, mint, or the audit hook — still
calls `destroy`, so no surviving flag-on stage is possible. The thin bin (`src/bin.ts`)
wires the real alchemy/better-auth/seed calls to the port (`src/adapter.ts`); tests never
perform a real deploy.

## Architecture

A pure, unit-tested core + a thin Effect bin (the `@kampus/founder-seed` /
`@kampus/preview-seed` repo tooling idiom — Node Effect tooling, never Python or an ad-hoc
shell script):

- `src/lifecycle.ts` — the pure core: `runStageLifecycle` over the `StageLifecyclePort`
  interface, the phase/error types, and the teardown-on-every-exit guarantee.
- `src/lifecycle.unit.test.ts` — the teardown-on-failure unit tests over the fake port.
- `src/adapter.ts` — the real port: alchemy deploy/destroy + the Cloudflare REST D1 lookup
  over `effect/unstable/process` (the `@kampus/orphan-sweep` / deploy.yml idiom), the
  better-auth sign-up, and the seeds over `@kampus/d1-rest`.
- `src/bin.ts` — the `audit-stage run` CLI.

## Running it

Run from the repo root (so `pnpm --filter @kampus/web exec alchemy …` resolves the stack).
Credentials come from the environment, never source:

```bash
node packages/audit-stage/src/bin.ts run [--stage <name>]   # default stage: audit
```

- `--stage` (optional) — the audit stage name (default `audit`, the `AUDIT_STAGE` of
  `apps/web/worker/environment.ts`).
- `$CLOUDFLARE_ACCOUNT_ID` / `$CLOUDFLARE_API_TOKEN` — the account + D1-write token (the
  token is the D1-lookup bearer; the seeds read it via `CredentialsFromEnv`).
- `$ALCHEMY_PASSWORD` / `$BETTER_AUTH_SECRET` — passed through to `alchemy deploy/destroy`.

Out of scope (later epic children): the audit logic itself (#1513–#1516), real-production
deploys, and scheduling.
