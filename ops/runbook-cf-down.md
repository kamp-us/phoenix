# Runbook: Cloudflare down

A Cloudflare-provider incident hits phoenix on **two surfaces at once**, and the response
differs by surface. The whole running system rides Cloudflare — the `apps/web` worker, its
production D1, and the `LiveDO` SSE fan-out are all Cloudflare primitives on one per-app
stack (ADR [0057](../.decisions/0057-multi-app-multi-worker-repo.md)) — so a CF outage is a
full app outage with **nothing to recover at our layer**. The agent pipeline is coupled to
real Cloudflare too: the CI-only integration tier and the merge-queue/preview e2e run against
a live deploy (ADR [0154](../.decisions/0154-integration-tier-is-ci-only.md)), so they red or
hang for the duration. The load-bearing posture for that second surface is **hold, don't
force-merge** — deploy is the agent boundary, release is a human act (ADR
[0083](../.decisions/0083-agents-deploy-humans-release.md)) — so a CF-caused red is waited
out, never bypassed.

## Symptoms

Two symptom clusters; a CF incident usually shows **both** at once. Confirm against the
external signal (see [Preconditions](#preconditions)) before assuming CF is the cause — the
same signatures can come from a bad deploy, so the status page is what distinguishes a
provider outage from our own regression.

**Production app**

- The site is unreachable or 5xx-ing broadly across routes (not one feature) — the worker,
  its `assets` binding (the SPA), and the API are all down together because they are one
  worker.
- `GET /api/health` fails to respond at all, or every request path errors — distinct from a
  Flagship-only degrade, which is the *typed 503* of ADR
  [0156](../.decisions/0156-health-probe-flagship-unreachable-is-typed-503.md) with the rest
  of the worker still serving. A whole-worker outage is CF; a lone `flagshipReachable:false`
  on an otherwise-200 probe is not this runbook.
- Reads and writes both fail: D1 is unreachable, so nothing degrades to read-only — it's dark.
- Live views are stale or 503 with `LIVE_UNAVAILABLE`; but unlike the isolated live-plane
  degrade ([live plane degraded](./runbook-live-plane-degraded.md)), here the *rest* of the
  app is down too. If only the live plane is affected, use that runbook, not this one.

**Agent pipeline**

- The **integration** CI job (the CI-only tier, ADR
  [0154](../.decisions/0154-integration-tier-is-ci-only.md)) fails at its deploy step or its
  black-box HTTP assertions — it deploys the real worker to real Cloudflare, so a CF outage
  either blocks the deploy or makes every over-the-network assertion fail.
- The **merge queue** stalls: the required checks re-run the same real-CF-coupled jobs, so
  enqueued PRs sit unmerged, and preview (`pr-<n>`) e2e red-or-hangs — a preview stage is a
  full isolated worker + D1 + DOs on the same provider (ADR
  [0088](../.decisions/0088-preview-deploy-environment.md)).
- The failure signature is a **timeout / connection error**, not a domain assertion — a green
  test suite that only fails to reach Cloudflare. This is the tell that the red is
  infrastructure, not the diff under review.

## Preconditions

- **Confirm it's Cloudflare, not us.** The authoritative external signal is the Cloudflare
  status page, <https://www.cloudflarestatus.com> — check it (and CF's status posts) before
  running any procedure. A recent merge to `main` deploying a broken worker produces
  overlapping symptoms; the status page is what tells a provider outage apart from our own
  bad deploy. If the status page is green, this is likely **not** a CF incident — suspect a
  recent deploy and treat it as an app regression instead.
- **Know your access boundary.** Nothing in this runbook requires — or grants — the ability to
  *fix* Cloudflare; recovery is on Cloudflare's side. The only privileged action available is
  a **human release/rollback** decision (a flag flip or a revert), which is infra-admin-only
  by ADR [0083](../.decisions/0083-agents-deploy-humans-release.md). Agents do not hold deploy
  credentials (ADR [0154](../.decisions/0154-integration-tier-is-ci-only.md)), so an agent's
  role during a CF incident is **observe, hold, and hand back**, never force through.
- **Capture the blast radius first.** Before acting, note which surfaces are affected (app,
  integration CI, merge queue, previews) and the incident's start time from the status page —
  this is what the verification step compares against on recovery.

## Procedure

There is no phoenix-side lever that restores Cloudflare; the procedure is to **classify,
hold, and avoid making it worse** until CF recovers.

1. **Confirm the provider outage.** Open <https://www.cloudflarestatus.com>. If the incident
   is listed, proceed; if not, stop and treat the symptoms as a possible bad deploy (revisit
   [Preconditions](#preconditions)).

2. **Production app — accept, don't thrash.** There is nothing to deploy around a provider
   outage: the worker, D1, and `LiveDO` all ride CF, so redeploying lands nowhere and a
   redeploy attempt can itself fail against the down provider. Do **not** attempt an
   `alchemy deploy` to "refresh" the worker during the incident. Leave production as-is and
   wait; the app returns when CF does, no action required.

3. **Agent pipeline — HOLD the merge queue, do not force-merge.** A CF-caused red on the
   integration job or a merge-queue stall is **expected** and is **not a signal about the PR's
   diff**. The correct posture is to wait it out:
   - Do **not** force-merge, admin-merge, or bypass required checks to get past a CF-caused
     red. Deploy is the agent boundary; a merge that skips the real-CF gate ships past the
     safety line ADR [0083](../.decisions/0083-agents-deploy-humans-release.md) draws.
   - Do **not** re-run the integration/e2e jobs in a tight loop hoping for green — they will
     keep failing until CF is back, burning CI minutes and obscuring the real signal.
   - Leave enqueued PRs enqueued; the queue drains itself once checks can pass again.

4. **Hand back / annotate.** If you are an agent mid-task and your PR's red is CF-caused, stop
   and hand back rather than escalating a fix — leave a short note on the PR that the red is a
   Cloudflare incident (link the status-page incident), not the diff, so the next actor
   doesn't rediscover it mid-incident. A human decides any release/rollback action per ADR
   [0083](../.decisions/0083-agents-deploy-humans-release.md).

5. **Escalate only a decision, never a workaround.** The only escalation is to a human with
   infra-admin authority, and only for a *release* decision (roll back a suspected-bad deploy
   once CF is back, or hold a release). See [Rollback / escalation](#rollback--escalation).

## Verification

Verify recovery in **surface order** — the app first (it unblocks users), the pipeline second
(it unblocks merges) — and confirm against the same signals you captured in the preconditions.

1. **Cloudflare status is green.** The status page shows the incident resolved. This is the
   precondition for everything below; a partial provider recovery can still red the pipeline.

2. **Production app is serving.** `GET /api/health` returns `200` with
   `status:"ok"` (a typed body per ADR
   [0156](../.decisions/0156-health-probe-flagship-unreachable-is-typed-503.md)); spot-check a
   read route and a live view. Reads and a write both succeed — D1 is reachable again, not
   just the worker.

3. **Agent pipeline is green.** Re-run (or let re-run) the integration job on a pending PR: it
   now deploys and its HTTP assertions pass. The merge queue resumes draining, and a `pr-<n>`
   preview e2e goes green. A CF-caused red clears on its own once the deploy step can reach
   Cloudflare — no PR change is needed to make it pass, which is itself the confirmation the
   red was infrastructure, not the diff.

## Rollback / escalation

- **Nothing to roll back at the provider layer.** The incident is Cloudflare's to resolve;
  there is no phoenix-side rollback that recovers a down provider. "Rollback" here means only:
  if, on recovery, the app is still broken, suspect a **bad deploy** that coincided with (or
  was masked by) the outage, and treat it as an app regression — a human infra-admin reverts
  the offending merge or holds the release (ADR
  [0083](../.decisions/0083-agents-deploy-humans-release.md)).
- **Escalate a decision, not a bypass.** Escalation goes to a human with infra-admin
  authority, and only to make a **release/rollback** call — never to force a merge past a
  CF-caused red. Building a CF-independent CI fallback is explicitly out of scope (ADR
  [0154](../.decisions/0154-integration-tier-is-ci-only.md) shuts that door): the integration
  tier is CI-only against real Cloudflare by design, and the response to its unavailability is
  to hold, not to fake it.
- **When to widen.** If the outage is prolonged and a release is genuinely time-critical, the
  decision to wait vs. take a manual path is a human infra-admin's, made against the real
  trade-offs — this runbook's standing default is **hold and wait**.
