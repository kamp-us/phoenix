# Ops runbooks

This is phoenix's **operational** doc surface: the runbooks an operator follows during an
incident, plus the measured capacity baseline. It is deliberately separate from the other two
doc surfaces — `.decisions/` holds the *why* (ADRs) and `.patterns/` holds *how the code is
shaped*; `ops/` holds **how to operate** the running system when something breaks. Reach for a
runbook here when the product is degraded and you need a procedure grounded in phoenix's real
stack, not generic ops boilerplate.

Every runbook here is grounded in the live surfaces it covers — the per-app production D1 (ADR
[0057](../.decisions/0057-multi-app-multi-worker-repo.md)), the unified `LiveDO` fan-out (ADRs
[0023](../.decisions/0023-live-views-sse-livedo.md)/[0037](../.decisions/0037-unified-void-aligned-live-do.md)),
the alchemy deploy model (ADR [0032](../.decisions/0032-alchemy-beta45-and-dev-model.md)), and
the CI-only integration tier's real-Cloudflare coupling (ADR
[0154](../.decisions/0154-integration-tier-is-ci-only.md)). When a runbook and the source
disagree, the source wins — fix the runbook.

## Runbooks

| Runbook | Covers | Status |
|---|---|---|
| [D1 export / restore](./runbook-d1-restore.md) | Recover the single production D1 from a bad migration; handles the FTS5 virtual-table export tax (ADR [0080](../.decisions/0080-site-search-lexical-bar-semantic-discovery.md)). Rehearsed once. | forthcoming |
| [Live plane degraded](./runbook-live-plane-degraded.md) | Stale views and `LIVE_UNAVAILABLE` 503s from the SSE fan-out — symptoms, triage, and the levers that exist today. | forthcoming |
| [Cloudflare down](./runbook-cf-down.md) | A Cloudflare incident, for both the app and the agent pipeline (the integration tier + merge queue couple to real CF, ADR [0154](../.decisions/0154-integration-tier-is-ci-only.md)). | forthcoming |
| [Capacity baseline](./capacity-baseline.md) | Measured limits: max SSE connections per `LiveDO`, hot-topic publish throughput, feed p95 under load — with the method that produced them. | forthcoming |

Each row links the file its sibling task fills in; a row marked **forthcoming** points at a doc
not yet written. The link target is the agreed filename so the surface is stable before the
content lands.

## Runbook shape

A failure-mode runbook follows this shape so an operator mid-incident always finds the same
sections in the same order:

- **Symptoms** — the observable signals that select this runbook (error strings, dashboards,
  what a user sees). What makes you reach for *this* one.
- **Preconditions** — what must be true before you run the procedure: access/credentials you
  need, the stage you're acting on, state to capture first.
- **Procedure** — the ordered steps to take, grounded in phoenix's actual commands and
  surfaces (named `alchemy` commands, real bindings, real routes), not generic advice.
- **Verification** — how you confirm the procedure worked (row counts, a working query, a
  green check) before you stand down.
- **Rollback / escalation** — how to back out if the procedure makes it worse, and who/what to
  escalate to when it's beyond the runbook.

The capacity baseline is a measurement record rather than a failure-mode procedure, so it
documents the **numbers and the method that produced them** instead of following the shape
above.

## Incidents

Post-incident diagnoses of pipeline/infra corruption — the mechanism trace, the vectors ruled
in/out, the containment that caught it, and the follow-up fix it names. Unlike a runbook (a
procedure to *run*), an incident diagnosis is a *record* of what happened and why.

| Incident | Covers |
|---|---|
| [#2778 primary-index mass staged deletion](./incidents/2778-primary-index-mass-staged-deletion.md) | The shared primary checkout's index accumulating 248 staged deletions of the instruction-trust set (`.claude/**`, `.decisions/**`) under worktree-isolated agents — vectors, main-sync's incidental containment, and the read-only attribution tripwire. |
