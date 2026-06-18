---
id: 0032
title: Upgrade to alchemy@2.0.0-beta.45 + effect@4.0.0-beta.74; accept deploy-infra-to-cloud as the dev model
status: accepted
date: 2026-05-29
tags: [alchemy, effect, dev, deploy, durable-objects, secrets]
---

# 0032 — Upgrade to alchemy@2.0.0-beta.45 + effect@4.0.0-beta.74; accept deploy-infra-to-cloud as the dev model

## Context

phoenix has been pinned to `alchemy@2.0.0-beta.44` + `effect@4.0.0-beta.70`
through [0026](0026-adopt-alchemy-effect-infra.md)–[0031](0031-local-first-dev-state.md).
Two pressures had accumulated against that pin:

- The co-hosted live DOs were authored on the inline `…Namespace<Self>()("Name", body)`
  form because the modular `class + .make()` form documented in alchemy's JSDoc
  was not implemented for DOs in beta.44 (recorded in
  [0028](0028-effect-durable-object-model.md)). The inline form forced an
  `as never` cast at the sibling-DO seam and prevented splitting the DO class
  (the typed identity) from the DO Layer (the implementation).
- `Alchemy.Secret`/`Alchemy.Variable`, `WorkerProps.bindings`-vs-`env`, and
  the bundled `LocalhostDns` were three independent surfaces overlapping
  `effect/Config` and `node:dns`. The next-beta release notes promised they
  collapsed.

Separately: the working assumption in [0031](0031-local-first-dev-state.md) was
that `alchemy dev` runs *fully offline* against a local workerd. That has
always been half-true — the worker runs locally, but the platform resources
(D1, R2, KV) it binds against are real Cloudflare resources, and there is no
maintained offline emulator for them in this stack. This ADR makes that fact
load-bearing rather than leaving it as a caveat in 0031.

## Decision

Upgrade the catalog in `pnpm-workspace.yaml` to:

- `alchemy: 2.0.0-beta.45`
- `@alchemy.run/better-auth: 2.0.0-beta.45`
- `effect: 4.0.0-beta.74`
- `@effect/platform-bun`, `@effect/platform-node`, `@effect/sql-pg`,
  `@effect/vitest: 4.0.0-beta.74`

Adopt the **modular `.make()` form for Durable Objects** that beta.45 ships:
the class becomes a lightweight Tag (`Cloudflare.DurableObjectNamespace<Self, Shape>()("Name") {}`),
and the implementation is a separate `…Live` Layer produced by `.make(body)`.
That seam retires the inline-form `as never` sibling-cast that the live DOs
had to carry (see `apps/web/worker/features/fate-live/connection-do.ts` and
`apps/web/worker/features/fate-live/topic-do.ts` headers, and the companion ADR for the
remaining sibling-resolution constraint).

Collapse the three deprecated surfaces:

- `Alchemy.Secret`/`Variable` → `Config.redacted("NAME")` from `effect/Config`,
  read at the boundary that needs it (e.g. the worker's session secret in
  `apps/web/worker/index.ts`).
- `WorkerProps.bindings` + `WorkerProps.env` → unified `WorkerProps.env`.
- bundled `alchemy/Util/LocalhostDns` → at the time, a small local `node:dns`
  shim in `apps/web/tests/integration/_localhost-dns.ts` for the integration
  harness, installed once in `_global-setup.ts`. (That shim was later removed
  when the harness moved to `Test.make` over real remote D1 — see
  [0082](0082-two-test-tiers-unit-integration.md); the deprecated-surface
  swap recorded here is what matters, not the shim that carried it.)

**Accept the dev model: `alchemy dev` deploys the infrastructure to real
Cloudflare and runs the worker locally in `workerd`.** There is no offline
emulation for D1/R2/KV in this stack; alchemy's own docs reject local
emulation as a goal (`concepts/local-development.mdx` in the alchemy docs —
"fidelity gaps, missing features, and false confidence"). [0031](0031-local-first-dev-state.md)
was correct about which **state store** is used during dev (file-based via
`Alchemy.localState()` so the diff-target is local), but the **resources
themselves are real**, in every developer's personal dev stage. This ADR
makes that explicit.

The state-store selector stays as recorded in 0031, but the selection signal
moves from `process.env.CI` to a dedicated `resolveStateMode` helper in
`apps/web/worker/env.ts` — `CI` is set for both the deploy
workflow and the integration-test job, so it cannot distinguish a real deploy
from a test run.

## Consequences

- **Easier.** The DO sibling-cast workaround is gone (the `.make()` Layer
  decouples the class identity from the implementation Layer, so the two
  circular DOs can be composed without `as never`). The session secret is
  read with the same `Config.redacted` machinery the rest of the backend uses.
  The worker's `env` is one surface, not two.
- **Cost — real-cloud-resources during dev.** Each developer needs an isolated
  dev stage (`alchemy deploy --stage <name>` or `alchemy dev --stage <name>`)
  so they don't collide with each other or with the shared `dev` / `staging`
  stages. The state store stays local during `alchemy dev` (offline
  diff-target), but the D1 database, the DO namespaces, and any KV/R2 bindings
  the stage references are real CF resources. The trade is real-cloud-fidelity
  during development for zero emulation-vs-prod schema drift.
- **Integration tests deploy a `test` stage.** The harness in
  `apps/web/tests/integration/_global-setup.ts` deploys a stage via `alchemy`,
  runs every test against the deployed worker URL, and tears it down on exit.
  No miniflare. (At the time, a `_localhost-dns.ts` shim existed only because
  the harness resolved stage URLs that occasionally routed through `*.localhost`
  for the local proxy — a `node:dns` patch, not a network emulator. It was
  removed when the harness later moved to `Test.make` over real remote D1; see
  [0082](0082-two-test-tiers-unit-integration.md).)
- **The companion ADR** ([0033](0033-mutual-do-layer-cycle-per-call-resolution.md))
  captures the one constraint the `.make()` form does **not** lift: co-hosted
  mutual DOs still cannot Init-bind each other; the sibling resolution stays
  per-call. The `.make()` upgrade and the per-call rule are two layers of the
  same problem, recorded separately.
- See [alchemy-durable-objects.md](../.patterns/alchemy-durable-objects.md)
  (modular form, sibling-resolution rule), [alchemy-stack-deploy.md](../.patterns/alchemy-stack-deploy.md)
  (state selection, stages), and the umbrella [0026](0026-adopt-alchemy-effect-infra.md).

## What was considered + rejected

- **Stay on beta.44.** Keeps the codebase frozen against a known-working pin
  but locks in the inline-DO form, the `as never` sibling cast, and the
  three deprecated surfaces. The maintenance cost of the workarounds outpaces
  the cost of one upgrade.
- **Add an offline emulator for D1/R2/KV.** Rejected upstream; would be
  phoenix-local work with no fidelity guarantee. The shared deploy-stage
  model is what alchemy is designed around.
