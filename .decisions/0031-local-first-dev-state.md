---
id: 0031
title: Local-first state for dev; remote state for CI and deploy
status: accepted
date: 2026-05-25
tags: [alchemy, dev, state, ci]
---

# 0031 — Local-first state for dev; remote state for CI and deploy

> Amended in part by [0032](0032-alchemy-beta45-and-dev-model.md): the
> **state store** selection recorded below stands, but the "fully offline"
> framing was half-true — `alchemy dev` runs the worker locally in `workerd`
> while the **resources** it binds (D1, KV, R2, DO namespaces) are real
> Cloudflare resources in a per-developer stage. The selection signal also
> moved from `process.env.CI` to a dedicated `resolveStateMode` helper in
> `apps/web/worker/env.ts` (because `CI` is set for both deploy and
> integration-test jobs and can't distinguish them).

## Context

An `Alchemy.Stack`'s `state` option chooses where alchemy stores the
deployed-resource state it diffs against, and that choice decides whether
`alchemy dev` can run offline.

- `Cloudflare.state()` is a **Cloudflare-hosted** store. Its Effect Layer
  requires credentials + an `HttpClient`, so *every* run — including
  `alchemy dev` — needs `alchemy login` and network.
- `Alchemy.localState()` is a **file-based** store. Its Layer needs only
  `FileSystem`/`Path` — no credentials, no network.

The local dev loop should run offline; CI and shared deploys need
reproducible, shared state. One store can't satisfy both: the Cloudflare-hosted
store forces network on the dev loop, and a local file store isn't shared
across machines or CI runs.

## Decision

Select the `state` store by environment in `alchemy.run.ts`:

```ts
state: process.env.CI ? Cloudflare.state() : Alchemy.localState()
```

- **Local dev** gets `Alchemy.localState()` — file-based, offline.
- **CI and shared deploys** get `Cloudflare.state()` — hosted, reproducible,
  shared.

## Consequences

- **Easier:** `alchemy dev` runs fully offline locally — no auth prompt, no
  external connections, worker in local `workerd`, state in local files
  (VERIFIED in a spike: `localState()` booted with zero external connections;
  `Cloudflare.state()` required `alchemy login`).
- CI and deploys still get reproducible, shared, Cloudflare-hosted state — the
  diff target is the same across machines and runs.
- `alchemy deploy` always needs network/auth regardless of store choice (it
  hits the CF API). The initial `alchemy login` and dependency install also
  need network once.
- See [alchemy-stack-deploy.md](../.patterns/alchemy-stack-deploy.md) (the
  `state` and "Local dev" sections) and the umbrella
  [0026](0026-adopt-alchemy-effect-infra.md).
