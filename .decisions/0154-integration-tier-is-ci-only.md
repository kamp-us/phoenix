---
id: 0154
title: The integration tier is CI-only — no local agent runs, no local fake
status: accepted
date: 2026-07-04
tags: [testing, integration, ci, cloudflare, pipeline, product-development-framework]
---

# 0154 — The integration tier is CI-only

## Context

The integration tier (ADR 0082) deploys the real worker to real Cloudflare — real
D1, real Durable Objects, real SSE over the network — and drives it black-box over
HTTP. That fidelity is the point: it catches what a local double cannot. But it has
two costs that collided on #2049 (the reaction live-count reconcile bug):

- It needs a Cloudflare deploy token. Pipeline coder agents run in a sandbox with
  **no deploy credentials** — a standing rule: no agent is issued deploy capability.
- So an agent cannot run the integration tier at all; it can only push and read CI.
  On #2049 that became a ~50-minute blind loop — a silent 120s test timeout, no
  signal, three cycles burned guessing.

The same real-CF-harness limit recurs on a different test tier — the e2e capability
gap (#1838) — so this is a shared constraint, not a one-off. Resolving #2061 also
unblocks #2031 AC3 (the deferred D1 cross-encoding proof, which was blocked on
exactly this harness gap).

Two escape doors were raised to close that gap. This ADR shuts both.

## Decision

**Integration tests run in GitHub Actions, period.**

1. **No local agent runs.** Coders do not run the integration tier locally, and no
   agent is issued deploy credentials. CI is the sole arbiter of the integration tier.
2. **No local / unit-tier fake of an integration concern.** We do not stand up a
   local-workerd or in-process double to substitute for a real-Cloudflare path. A
   green fake that real Cloudflare would fail is worse than no test — the ADR 0040
   trap (a local double that isn't the real engine). Live SSE fan-out through a
   deployed Durable Object is definitionally an integration concern and is tested as
   one.

Both doors are shut explicitly so no future agent reopens them under loop-time
pressure.

## Consequences

CI-only is tolerable only because the integration tier is made **CI-legible**: a
failing test must fail fast and **name its cause in CI stdout**, never hang on a
blind timeout. Concretely (proven on #2049):

- assert the decisive signal on the direct HTTP response **before** entering a long
  SSE read;
- cap every wait well below the suite timeout, with a distinct message per failure
  mode;
- no `console` probes on the delivery path — worker logs go to Cloudflare's log
  stream, unreadable from CI, so they are pure noise in this loop.

#2049 is the reference instance: a former 50-minute blind loop became a ~2-second
named cause. That discipline is canonized separately in `.patterns/` so every future
integration test is legible by default.

Enforcing this decision through a CI/workflow (`.github/**`) change is control-plane
(§CP) → human-merge (approve-then-enqueue, ADR 0135); a change confined to the test
tier (`apps/web/tests/**`) is non-§CP and ships through the normal pipeline. This ADR
*file* itself is a `.decisions/` doc — non-§CP.

Reference this decision by **slug** in code comments
(`// See ADR: integration-tier-is-ci-only`) so the ADR-numbering migration (#2058)
does not break the link.

Built on ADR 0082 (which established the tier). Forcing case: #2061.
