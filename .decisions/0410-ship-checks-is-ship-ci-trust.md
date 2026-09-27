---
id: 0410
title: Ship trusts CI through `ship checks` alone, never a run-evidence bundle
status: accepted
date: 2026-09-26
tags: [pipeline, ci, ship, run-evidence, retirement]
---

# 0410 — Ship trusts CI through `ship checks` alone, never a run-evidence bundle

**What this decides:** ship stops reading a SHA-bound run-evidence bundle. `ship checks` is its whole
CI trust, the bundle producer and both bundle verbs are deleted, and the one check only the producer
ran moves into normal CI.

## Context

ADR [0054](0054-run-evidence-bundle.md) made the merge gate trust a SHA-bound run-evidence bundle
instead of an opaque "CI is green". Its reason was that a green read cannot say which suites ran, or
whether the green run belonged to this head or a stale earlier push. ADR
[0056](0056-bundle-storage-transport.md) stored that bundle as a GitHub Actions artifact named
`run-evidence`, fetched by head SHA. `run-evidence.yml` produced it with crabbox, and ship read it at
its step 5 through `fabrika ship evidence`.

`ship checks` (ship step 4) now proves what 0054 wanted the bundle for:

- It rolls up only the base branch's declared required set, so a gate outside that set cannot green
  or red the head.
- It counts a run only when the run carries the resolved head and its event opened that head, so a
  stale push or a base-context run proves nothing.
- It refuses on exit `20` when no workflow the repo authors inspected the head.

Meanwhile the bundle blocked every adopter that runs normal CI without a crabbox producer:
`ship evidence` answered `absent`, ship refused every PR, and people merged by hand, skipping review.

The producer did two things no other job did. It ran the worker-bundle node-core assertion
(`apps/web/scripts/bundle-assert`, ADR [0118](0118-error-crash-monitoring-sentry-saas.md)), and it
ran `apps/web`'s `vitest --project unit` inside a crabbox `local-container`. That second run is the
same command `ci.yml`'s `unit` job runs through `test:unit`, so it tested nothing normal CI misses.

ADR [0132](0132-merge-queue-for-base-freshness.md) added `merge_group:` to `run-evidence.yml` so the
bundle would bind the merge queue's batch head. That trigger leaves with the workflow. The rest of
0132 stands, including `ci.yml`'s own `merge_group:` trigger.

ADR [0071](0071-enforce-control-plane-at-github.md) named `run-evidence` in the required-check set it
recommended. The live `main` ruleset no longer requires it: its required contexts are `ci-required`,
`governance floor at head`, `scan changed files for leaks` and `validate skill frontmatter`. So
nothing that 0071 still enforces depends on the bundle.

The ruling is umut's (founder), 2026-09-26:
https://github.com/kamp-us/phoenix/issues/9815#issuecomment-5850297119.

## Decision

**Ship's CI trust is `fabrika ship checks` at the head, and no SHA-bound bundle stands beside it.**

- `run-evidence.yml` is deleted, and so is its re-dispatch from `release-please.yml`.
- `fabrika ship evidence` and `fabrika ci evidence` are deleted with their helpers and tests. Ship's
  steps renumber without the run-evidence step.
- The worker-bundle node-core assertion runs as the `bundle-assert` job in `ci.yml`, on every event,
  and `ci-required` requires it. It still blocks a merge the way it did inside the producer.
- crabbox and its `0.31.0` pin are dropped. Its only test run duplicated the `unit` job.

This supersedes ADR 0054 and ADR 0056 in full. 0056 decided nothing beyond the bundle's storage.
It also supersedes ADR [0086](0086-ship-it-foreign-repo-degradation.md), which decided how ship
degrades its run-evidence guard in a repo with no producer. With no guard left, there is nothing to
degrade.

**Banned.** Reintroducing a merge-gate read of a CI-produced bundle without a record that supersedes
this one. A check that must block a merge runs as a job `ci-required` covers.

## Consequences

An adopter with ordinary CI can ship through fabrika without standing up a producer. Phoenix drops a
pre-1.0 pin, a workflow, and a five-state reader.

Removing the step does not touch the `ship checks` hole tracked in
[#9808](https://github.com/kamp-us/phoenix/issues/9808), where the rollup can answer green before
`ci-required` posts. The bundle's check run was never in the required set, so `ship checks` never
read it. What still stops an early merge is the ruleset's required `ci-required` context on the pull
request and on the merge-queue batch.

## Records

- Issue: https://github.com/kamp-us/phoenix/issues/9815
- Ruling: https://github.com/kamp-us/phoenix/issues/9815#issuecomment-5850297119
- Supersedes: ADR [0054](0054-run-evidence-bundle.md), ADR [0056](0056-bundle-storage-transport.md),
  ADR [0086](0086-ship-it-foreign-repo-degradation.md)
- Vocabulary: retires the glossary's `run-evidence bundle` and `crabbox` rows in `.glossary/TERMS.md`.
