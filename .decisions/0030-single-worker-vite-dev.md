---
id: 0030
title: Single worker via Worker+assets, with a two-process HMR dev loop
status: accepted
date: 2026-05-25
tags: [vite, worker, dev, hmr, assets]
---

# 0030 — Single worker via Worker+assets, with a two-process HMR dev loop

## Context

phoenix is **one worker** serving both the React SPA and the API/fate/DO
backend on a single URL (the CLAUDE.md "one worker" rule). alchemy offers
**two non-mixable worker runtime paths**, and the choice between them is
forced by what each can host:

- **`Cloudflare.Worker` + `assets`** — a hand-written, Effect-native worker
  (`bind()`, the Effect DO model) whose `main` is the backend; `assets`
  serves a pre-built `dist/client`. Under `alchemy dev`'s local workerd
  runtime it watch-rebuilds the backend but serves `dist/client`
  **statically — no client HMR**.
- **`Cloudflare.Vite`** driving `@distilled.cloud/cloudflare-vite-plugin`
  (alchemy's own fork) — integrated client HMR, but its worker entry is a
  plain `export default {fetch}`. It **cannot host phoenix's Effect-native
  worker** (`bind()`, the Effect DO model). Choosing it forces an
  assets-only `Web` worker bound to a separate `Backend` worker — two URLs,
  the one-worker model abandoned.

HMR is a hard requirement. And alchemy is **incompatible** with the official
`@cloudflare/vite-plugin` — that plugin only drives the `Cloudflare.Vite`
(plain-handler) path, so it can't be bolted onto the Effect-native worker to
buy single-process HMR. You can't get `bind()`/Effect-DOs *and* integrated
HMR on one worker.

## Decision

Keep the single worker via **`Cloudflare.Worker` + `assets`** (the
Effect-native path) — **not** `Cloudflare.Vite`, **not** a two-worker split.
Vite builds the SPA to `dist/client` as a normal build step; the worker
serves it via the `assets` binding, with `runWorkerFirst` routing `/api/*`
and `/fate*` to the worker and everything else to the assets.

Dev is **two processes**:

- `vite dev` — React HMR plus the `fate()` codegen plugin.
- `alchemy dev` — the worker + DOs + D1 with live bindings and backend
  watch-rebuild.

`vite dev` proxies `/api` and `/fate*` to the worker. The proxy must target
`http://127.0.0.1:1337` and **force a `Host: phoenix.localhost` header** —
`alchemy dev` serves the worker vhost-routed and Node can't resolve
`*.localhost` (a `target: "http://phoenix.localhost:1337"` fails with
`ENOTFOUND`).

Drop `@cloudflare/vite-plugin` from `vite.config.ts`; keep `react()` and
`fate()` (the codegen plugin is orthogonal to Cloudflare — it reads the
server's `Entity<>` types regardless of deploy path).

## Consequences

- **The "one worker" rule holds.** The second terminal is the Vite dev
  server, **not** a second worker — it's gone at deploy, where one worker
  serves both the built SPA and the backend.
- **Full loop is live:** client HMR from `vite dev`, backend hot-reload from
  `alchemy dev`. **Verified by a browser spike:** an SSE stream flowed through
  the Vite proxy and **editing a React component did not drop the live
  connection**.
- **Costs (accepted, not blockers):**
  - Two terminals instead of one command.
  - A dev/prod routing-fidelity gap — in dev the SPA is served by `vite dev`
    and routes through the Vite proxy rules, rather than the prod
    `runWorkerFirst`/`assets` precedence. Keep this in mind when debugging
    routing.
- **Rejected alternatives:** `Cloudflare.Vite` (can't host the Effect-native
  backend); two workers (extra hop, breaks one-worker).
- See [alchemy-worker.md](../.patterns/alchemy-worker.md) and
  [alchemy-stack-deploy.md](../.patterns/alchemy-stack-deploy.md). Under the
  umbrella [0026](0026-adopt-alchemy-effect-infra.md); the dev-state choice
  (`localState` vs `Cloudflare.state`) is [0031](0031-local-first-dev-state.md).
