---
id: 0026
title: Adopt alchemy-effect as the infrastructure layer
status: accepted
date: 2026-05-25
tags: [alchemy, infrastructure, worker, cloudflare]
---

# 0026 — Adopt alchemy-effect as the infrastructure layer

## Context

phoenix's Cloudflare infrastructure is declared imperatively in `wrangler.jsonc`
— bindings, DO classes, migrations, assets — and reached at runtime via raw
`env.PHOENIX_DB` / `env.CONNECTION_DO` from an `export default {fetch}` worker,
with hand-written `cloudflare:workers` DO classes. Infra and runtime are two
disjoint worlds glued by stringly-typed env: a binding declared in the JSONC has
no compile-time link to the code that reaches for it, and a typo or a missing
entry surfaces only at runtime.

[alchemy-effect](https://github.com/usirin/alchemy-effect) expresses cloud
infrastructure **and** application logic as one type-safe Effect program. A
`bind()` call contributes the binding's deploy-time metadata **and** resolves a
typed runtime client from the same expression — declaration and access are the
same line of code.

This is **not** an Effect migration. phoenix is already on effect v4 and so is
alchemy; only the infra seam changes. The rebuild lands in the same PR as these
ADRs.

## Decision

Adopt alchemy-effect as phoenix's infrastructure layer.

The worker becomes `Cloudflare.Worker<Phoenix>()("phoenix", props, body)` with
two phases:

- **Init phase** binds resources —
  `yield* Cloudflare.D1Connection.bind(PhoenixDb)`, `yield* ConnectionDO` —
  resolving typed clients that are in scope for the whole worker lifetime.
- **Runtime phase** returns `{fetch}`.

Resources are declared in an `alchemy.run.ts` `Alchemy.Stack`, **replacing
`wrangler.jsonc` entirely**; deploy via `alchemy deploy`.

The Effect domain layer (the `effect-*` patterns) and the fate protocol/client
layer (the `fate-*` patterns) are unchanged.

The sub-decisions this umbrella entails are recorded separately:

- HTTP routing — [0027](0027-http-router-drop-hono.md)
- the Durable Object model — [0028](0028-effect-durable-object-model.md)
- the runtime — [0029](0029-worker-runtime-servicemap.md)
- the single-worker / dev shape — [0030](0030-single-worker-vite-dev.md)
- dev state — [0031](0031-local-first-dev-state.md)

## Consequences

- **Infrastructure is typed code in one language** — no YAML, no second runtime.
- **`bind()` makes an unwired binding a compile error**, not a runtime surprise.
- **Deploy and runtime share one definition** — the line that records binding
  metadata is the line that resolves the client.
- **Cost:** a new dependency and toolchain (the `alchemy` CLI, the stack file)
  replacing `wrangler.jsonc`; the team learns the two-phase Worker model.
- See [alchemy-overview.md](../.patterns/alchemy-overview.md) and the sub-decision
  ADRs [0027](0027-http-router-drop-hono.md)–[0031](0031-local-first-dev-state.md).
