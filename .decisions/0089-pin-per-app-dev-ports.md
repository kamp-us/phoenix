---
id: 0089
title: Pin a distinct `alchemy dev` port per app, with `strictPort`
status: accepted
date: 2026-06-19
tags: [dev, alchemy, multi-app]
---

# 0089 — Pin a distinct `alchemy dev` port per app, with `strictPort`

## Context

`alchemy dev` serves each app's worker on a local port that defaults to **1337 with
silent fallback to the next free port** (`props.dev?.port ?? 1337`, then "next free port
unless `strictPort`"). With one app (ADR 0030) this was invisible: `apps/web` always got
1337, and its Vite proxy hardcodes `http://127.0.0.1:1337` as the target it forwards
`/api` and `/fate` to.

Adding `apps/dashboard` (ADR 0056/0057 — a second worker, run alongside web by
`pnpm dev` → `turbo run dev dev:worker`) broke that silently. Both apps defaulted to
1337, so the two `alchemy dev` instances **raced** for the port: whichever booted first
won 1337, the other slid to 1338. But **each app's Vite proxy still hardcodes 1337**, so
when the dashboard won the race, web's `/api/auth/*` and `/fate` requests were delivered
to the *dashboard* worker — which has no auth routes, no pasaport, and none of the sözlük
D1 tables. The symptom was a blanket 500 on every signup/login/fate call, plus "Network
connection lost" churn on reload, with no error pointing at the cause: the request was
simply going to the wrong worker. The boot-order race made it look intermittent. It cost
a full debugging session to localize, because nothing in the failure named the port.

## Decision

Each app pins an **explicit, distinct** `dev.port`, with **`strictPort: true`**:

- `apps/web` → `dev: {port: 1337, strictPort: true}` (matches its existing Vite proxy
  target — zero proxy change).
- `apps/dashboard` → `dev: {port: 1338, strictPort: true}`, and its Vite proxy targets
  1338.

Every new app added under `apps/` claims the next free port in this fixed assignment and
pins it the same way, keeping the worker's `dev.port` and its Vite proxy `target` in sync.

`strictPort: true` is load-bearing, not decoration. Pinning distinct ports alone fixes
only the happy-path race; the moment *anything* already holds the pinned port (a leaked
`alchemy dev` daemon from a prior session, another local service), the default
silent-next-free-port fallback re-introduces the exact misroute — web slides off 1337
while its proxy still points there. `strictPort` converts that case from **silent-wrong**
into **loud-stop**: `alchemy dev` fails immediately with "port in use" instead of booting
on the wrong port. The failure mode we optimize for is *diagnosability* — a hard bind
error is fixed in seconds; a silent misroute cost an evening.

We **reject dynamic port discovery** (Vite reading the worker's actually-bound port
instead of hardcoding it), which would remove the coupling entirely and leave a single
source of truth. It is the more "correct" design, but `strictPort` already makes the port
**deterministic**, so hardcode-but-pinned is safe — and wiring the bound port out of
`alchemy dev` into the Vite config is materially more complex than a two-line pin. We take
the simpler option and accept the coupling below as its known cost.

## Consequences

- **The misroute is structurally prevented**, not just papered over. Ports are
  deterministic regardless of which app's `alchemy dev` boots first.
- **A port collision now fails loudly.** A leaked daemon (or any process) on a pinned port
  makes `pnpm dev` hard-fail with a bind error instead of silently serving on the wrong
  port. This is the intended trade: clear stale dev processes
  (`pkill -f 'alchemy.*dev'; pkill -f workerd`) and re-run, rather than chase a phantom
  500. The loud failure is a feature — it surfaces the leaked-daemon problem instead of
  hiding it.
- **Accepted cost: two sources of truth for the port** — the worker's `dev.port` and the
  Vite proxy `target` must stay in sync by hand. The same-PR comment on each side and this
  ADR are the mitigation; the alternative (dynamic discovery) was considered and rejected
  above. Adding an app means picking the next port and setting it in *both* places.
- **Deploy is unaffected.** `dev.port` is local-dev-only and ignored by `alchemy deploy`;
  both apps' deploy paths are unchanged.
