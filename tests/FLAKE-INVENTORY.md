# Flake inventory & quarantine list

The single living list of known recurring CI flakes — what they are, where they
live, which check they redden, and whether each one is bounded (on a path to a
fix) or abandoned (a deletion candidate). This is the Phase-1 foundation of the
test-flake elimination epic [#765](https://github.com/kamp-us/phoenix/issues/765):
make the flake set **visible and bounded** before any determinism fix begins.

This list is **living, not exhaustive**. Day-one it carries the one known live
flake plus whatever a best-effort CI-history scan surfaced; new signatures are
appended as they recur. A flake belongs here the moment it reddens a required
check a second time without a code change explaining it.

## The un-quarantine bar

A quarantined flake is a **debt with a due date**, never a permanent tenant.
The bar:

- **Fix or delete — never rerun-to-green forever.** Every quarantined flake must
  be either root-caused-and-fixed (made deterministic) **or** deleted within a
  bounded window. Reaching green by rerunning the suite is not a resolution; it
  hides the debt and reddens the next innocent PR (this is exactly how #613
  flaked the zero-worker-code PR [#755](https://github.com/kamp-us/phoenix/pull/755)).
- **No owner + no determinism issue filed ⇒ deletion candidate.** A flake with
  no linked determinism issue and nobody driving it is not a tenant of this
  list; it is a test to delete. A flaky test that is never going to be fixed is
  worse than no test — it trains readers to ignore red.
- **`quarantined` is a transient state.** An entry must not sit in
  `quarantined` indefinitely. Either it advances to `root-cause-filed` (a
  determinism issue now owns it) or it is `deleted`. The terminal healthy state
  is `fixed`.

This bar is the reason the status vocabulary below is fixed and small: a reader
must be able to tell a **bounded** flake (`root-cause-filed`, `fixed`) from an
**abandoned** one (`quarantined` with no movement, or a `deleted` stub).

## Status vocabulary

| Status             | Meaning                                                                                  | Bounded? |
| ------------------ | ---------------------------------------------------------------------------------------- | -------- |
| `quarantined`      | Recurring flake acknowledged here; not yet owned by a determinism issue. **Transient** — must advance or be deleted. | No (yet) |
| `root-cause-filed` | A determinism issue owns the fix; the flake is bounded by that issue's resolution.        | Yes      |
| `fixed`            | Made deterministic; kept as a record so a regression is recognized, not rediscovered.     | Yes      |
| `deleted`          | Test removed (no owner, no determinism issue, or obsoleted). Kept as a tombstone so it is not silently reintroduced. | Yes      |

## Inventory

### SSE/DO cold-start 500 on the held live stream

- **Signature:** `AssertionError: expected 500 to be 200 // Object.is equality`
- **Suite / file:** integration — `apps/web/tests/integration/fate-live.test.ts`
  (`live views — /fate/live > subscribe → post.submit → prependNode frame
  arrives on the held SSE stream`, the assertion at `fate-live.test.ts:93`)
- **Reddened CI check:** `integration tests` → `ci-required` (workflow
  [`ci.yml`](../.github/workflows/ci.yml))
- **First observed:** [#613](https://github.com/kamp-us/phoenix/issues/613)
  (closed as a symptom — the assertion was relaxed/retried, the determinism was
  never fixed). Re-observed flaking the zero-worker-code PR
  [#755](https://github.com/kamp-us/phoenix/pull/755), and again on a `main` CI
  run on 2026-06-19.
- **Status:** `fixed` →
  [#769](https://github.com/kamp-us/phoenix/issues/769) (SSE/DO cold-start 500
  determinism child of epic #765), fixed in PR
  [#775](https://github.com/kamp-us/phoenix/pull/775). The first `post.submit`
  after subscribe raced the `ConnectionDO`/`TopicDO` cold start; the DO was not
  yet warm, so the publish returned 500 instead of 200. The fix adds a
  `liveControlWarm` step that warms the cold topic-role DO before the held stream
  is exercised, making the assertion deterministic. Kept as a record so a
  regression is recognized, not rediscovered.

### report.submit D1 read-after-write staleness

- **Signature:** `report.test.ts > report.submit persists created=true` —
  assertion got `false` (expected the created record to persist)
- **Suite / file:** integration — `apps/web/tests/integration/report.test.ts`
  (`report.submit persists created=true`)
- **Reddened CI check:** `integration tests` → `ci-required` (workflow
  [`ci.yml`](../.github/workflows/ci.yml))
- **First observed:** on the `main` push of commit `cf80e7e` (the
  [#779](https://github.com/kamp-us/phoenix/pull/779) merge). A D1
  **read-after-write staleness** flake — a write not yet visible to an
  immediately-following read — distinct from the #613 SSE/DO cold-start 500
  above (fixed by #769).
- **Status:** `root-cause-filed` →
  [#713](https://github.com/kamp-us/phoenix/issues/713) (the D1
  read-after-write determinism family; #708 is the sibling signature). The
  determinism fix belongs to #713's lane — this entry inventories it under epic
  [#765](https://github.com/kamp-us/phoenix/issues/765) but does not own the fix.

## Scope notes

- **This list is not the fix.** Making any flake deterministic is the job of the
  per-class determinism children of [#765](https://github.com/kamp-us/phoenix/issues/765)
  (e.g. #769 for the SSE/DO cold-start class). A flake-rate metric/budget is a
  separate child. This document only makes the set visible, owned, and bounded.
- **Quarantine ≠ heal-ci rerun.** Quarantining a flake here is an explicit,
  recorded, time-bounded decision with an owner. It is not the same as a CI
  self-heal rerun, which is an unrecorded retry that leaves no debt trail. A
  rerun is allowed to get a known-transient run green **once**; it does not
  remove the obligation in the bar above.
