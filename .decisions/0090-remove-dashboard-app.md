---
id: 0090
title: Remove `apps/dashboard` — unused pipeline-visualization meta-tooling; `web` is the sole app, the multi-app shape (ADR 0057) stands
status: accepted
date: 2026-06-19
tags: [infra, repo-shape, multi-app, pipeline, deploy]
---

# 0090 — Remove `apps/dashboard` — unused pipeline-viz meta-tooling

## Context

`apps/dashboard` (`@kampus/dashboard`) was the repo's second worker app: a React +
Cloudflare-Worker SPA that **visualized the agent pipeline** — rendering epics, the
release queue, dependency topology, and gate verdicts read from `kamp-us/phoenix`'s
own issues (its worker bound a `GITHUB_TOKEN` to fetch them). It was actively built
(its own `alchemy.run.ts` stack, DOs, a `features/pipeline` service with tests) and
CI-deployed (a `dashboard` leg in `deploy.yml`'s matrix, plus a dedicated
`DASHBOARD_GITHUB_TOKEN` repo secret provisioned by `infra/ci-credentials/github.ts`).

It served **no product purpose**. It visualized the operation of the agent pipeline,
not anything a kamp.us user touches — and the release queue it rendered was empty. The
week-2 exec review named the failure mode directly: *the operation has become its own
customer* — we had built and were paying CI to deploy a tool whose only audience was
the pipeline watching itself. That is meta-tooling, and meta-tooling that visualizes an
empty queue earns nothing.

## Decision

Remove `apps/dashboard` entirely — the whole package (worker, SPA, `alchemy.run.ts`
stack, DOs, the `features/pipeline` code + tests) — and every surface that existed
**only** to support it:

- The `dashboard` legs in `deploy.yml`'s `deploy` and `cleanup` matrices, and the
  now-dead `needs-github-token` / `GITHUB_TOKEN` wiring that fed only the dashboard
  worker. `needs-auth` and the matrix structure stay (the next app reuses them).
- The `DASHBOARD_GITHUB_TOKEN` provisioning in `infra/ci-credentials/github.ts` (the
  one CI secret that was supplied-not-minted, for dashboard's authenticated issue reads).
- The doc framing that named dashboard as the example second app (`CLAUDE.md`,
  `.patterns/alchemy-ci-cd.md`, `.patterns/effect-testing.md`, the ship-it skill's
  `apps/**` routing notes, the dev-port comment in `apps/web/worker/index.ts`) —
  rephrased to be generic ("a future second app") rather than naming the deleted one.

**ADR [0057](0057-multi-app-multi-worker-repo.md)'s multi-app/multi-worker principle
still stands.** The repo remains shaped for one worker per app under `apps/`; `web` is
simply the **only** app for now. Dashboard was the example second app, and removing it
does not retract the shape — the `app` matrix, per-app stack, and per-app stage all
remain, ready for the next genuine app.

## Consequences

- **`apps/web` is the sole worker.** With one app, `deploy.yml`'s `needs-github-token`
  flag and the `GITHUB_TOKEN` env it gated are gone; every matrix leg is now `web`
  (`needs-auth: true`).
- **ADR [0089](0089-pin-per-app-dev-ports.md) is moot.** Per-app `alchemy dev` port
  pinning existed to stop the web/dashboard port race; with one app there is no race.
  The `apps/web` pin (`dev.port: 1337, strictPort: true`) is kept as-is — it is correct
  and cheap, and is the assignment the next app's pin would build on — but the
  multi-app race it defended against cannot occur until a second app returns.
- **ADR [0088](0088-preview-deploy-environment.md) loses its dashboard leg.** The
  `preview` environment decision is unchanged and fully stands; only its second-app
  deploy leg is removed.
- **Live cloud resources are NOT torn down by this code change.** The deployed
  dashboard worker + D1 + DOs (prod and any open `pr-<n>` previews) persist until a
  credentialed `alchemy destroy` is run by a human, and the `DASHBOARD_GITHUB_TOKEN`
  GitHub Actions secret persists until revoked by hand. Both are out-of-band infra
  follow-ups, tracked in the removal PR, not part of this code deletion.
