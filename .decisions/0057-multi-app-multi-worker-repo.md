---
id: 0057
title: Multi-app, multi-worker repo — per-app package owns its own `alchemy.run.ts` stack + per-app stage, reusing the account-global state store and four CI secrets (no second bootstrap); CI must build + deploy each app
status: accepted
date: 2026-06-14
tags: [infra, alchemy, ci, repo-shape]
---

# 0057 — Multi-App, Multi-Worker Repo — Per-App Stack, Per-App Stage, Shared State Store and Secrets

**Note ([0090](0090-remove-dashboard-app.md)):** `apps/dashboard` — used throughout this
ADR as the example second app — was removed as unused pipeline-viz meta-tooling. This
ADR's principle is unchanged and stands: the repo is still one-worker-per-app under
`apps/`; `web` is simply the only app for now, and the next genuine app reuses this shape.

## Context

phoenix shipped as a single Cloudflare Worker: `apps/web` is the only app, and its
`alchemy.run.ts` declares the one `Alchemy.Stack("phoenix", …)` that deploys it (ADR
0026–0031). `CLAUDE.md` opens with "A single Cloudflare Worker." A second app
(`apps/dashboard`) is incoming, which makes that statement false — so the repo's
identity has to be settled and recorded *before* the second app is scaffolded, or
every later decision inherits an unstated shape.

The codebase already implies the answer. `apps/web/alchemy.run.ts`'s docblock says it
lives in the `@phoenix/web` package "because pnpm isolates `node_modules` — `alchemy`/
`effect` resolve from here, not the repo root," and its `migrationsDir`/`assets` paths
are relative to that package dir. The stack is *of* the app, not of the repo. Two
account-global pieces are already shared and need no per-app duplication:

- **State store.** `Cloudflare.state()` (the hosted alchemy state store) is bootstrapped
  once per Cloudflare account and keyed by stack name; `infra/ci-credentials/github.ts` provisions its
  bearer token + AES key into the account-wide Secrets Store on first deploy.
- **CI secrets.** The four repo secrets `infra/ci-credentials/github.ts` mints
  (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ALCHEMY_PASSWORD`,
  `BETTER_AUTH_SECRET`) are repo-level and account-scoped — a second app deploys with the
  same token, the same account, the same alchemy password, the same auth secret.

So the only real question is where the *second app's stack* lives: its own package, or
folded into one combined stack.

## Decision

phoenix is a **multi-app, multi-worker repo**. Each app under `apps/` is its own pnpm
package that owns its own worker and its own infra:

- **Per-app package + per-app stack.** Each app declares its own `alchemy.run.ts` calling
  `Alchemy.Stack("<app>", …)` — `apps/web` is `@phoenix/web` with
  `Alchemy.Stack("phoenix", …)`; `apps/dashboard` will be `@phoenix/dashboard` with its
  own `Alchemy.Stack("dashboard", …)`. The stack lives in the package (next to the worker
  it deploys) because pnpm isolates `node_modules` and the resource paths are
  package-relative. Each app is a **separate, independent worker** with its own bindings,
  DOs, and D1.
- **Shared account-global state store + secrets, no second bootstrap.** Every app's stack
  reuses the one `Cloudflare.state()` store and the four CI secrets that
  `infra/ci-credentials/github.ts` already provisioned. Adding an app does **not** re-run the
  `infra/ci-credentials/github.ts` one-shot — the store and secrets are account-global, and the alchemy
  state store keys by stack name so a second stack lands beside the first without
  collision.
- **Per-app stage isolation,** mirroring `apps/web`: `prod` on push to main, `pr-<n>`
  previews on PRs, each stage an isolated copy of *that app's* worker + D1 + DOs.

### Alternative considered — one combined stack

Fold both workers into a single `Alchemy.Stack` (one `alchemy.run.ts` that yields both
the web and the dashboard worker Tags). Rejected:

- **Package boundary fights it.** The stack must resolve `alchemy`/`effect` and
  package-relative `migrationsDir`/`assets` from *one* package's `node_modules`; a combined
  stack spanning two packages has no honest home — it would reach across the pnpm
  isolation the existing docblock calls out as the reason the stack lives where it does.
- **Coupled blast radius.** One stack deploys both workers as a unit: a dashboard change
  re-plans and can fail the web deploy, and the per-app `pr-<n>` stage isolation collapses
  into one shared stage. Per-app stacks keep each app's deploy, preview, and teardown
  independent.
- **No shared-resource savings to bank.** The things worth sharing — the state store and
  the secrets — are *already* account-global and reused by name. A combined stack buys no
  reuse the per-app model doesn't already get; it only adds coupling.

Per-app stack wins: it matches the package boundary the code already lives behind, keeps
each app's deploy independent, and still shares everything that's genuinely account-global.

## Consequences

- **The repo is multi-worker.** "One worker" is retired as the repo's identity;
  `CLAUDE.md` describes the per-app-worker model (web today, dashboard incoming). Adding
  an app is: new `apps/<app>` package, new `alchemy.run.ts` with `Alchemy.Stack("<app>",
  …)`, new per-app stages — no new state-store bootstrap, no new secrets.
- **CI must fan out over apps (spec for the CI child).** `.github/workflows/deploy.yml`
  today hardcodes the single app — it builds `pnpm --filter @phoenix/web build`, deploys
  `pnpm --filter @phoenix/web exec alchemy deploy --stage "$STAGE"`, and tears down the
  same filter on PR close. With a second app, **deploy must build *and* deploy *each*
  app** (and cleanup must destroy each app's `pr-<n>` stage). The fan-out reuses the same
  four secrets and the same `prod`/`pr-<n>` stage convention per app; this ADR is the spec
  the CI child implements against. Out of scope here: the actual workflow edit and the
  `apps/dashboard` scaffold are separate children.
- **`infra/ci-credentials/github.ts` stays a single one-shot.** It provisions account-global,
  repo-level credentials; it is not re-run per app. If a future app needs a *new* secret,
  that secret is added to this one stack, not a second credential stack.
