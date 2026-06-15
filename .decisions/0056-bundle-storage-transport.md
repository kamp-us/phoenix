---
id: 0056
title: Run-Evidence Bundle Storage Is a CI Run Artifact, Versioned by schemaVersion
status: proposed
date: 2026-06-14
tags: [pipeline, ci, review-code, ship-it, auto-merge, storage]

# 0056 — Run-Evidence Bundle Storage Is a CI Run Artifact, Versioned by schemaVersion

## Context

ADR [0054](0054-run-evidence-bundle.md) fixed the run-evidence bundle's *contract* — the
manifest fields and their meaning (§2: `schemaVersion`, `commit`, `run`, `checks[]`,
`tests`, `logs`) — and the gate's mechanical consumption of it (§3: `ship-it` asserts the
bundle exists, `bundle.commit == head SHA`, and every required check is `pass`;
`review-code` cites its structured results). It deliberately deferred two downstream
details to "the implementation issue" (this one, #243, a Phase-1 child of epic #238):

1. **Storage / transport** — *where* the bundle physically lives and *how*
   `ship-it`/`review-code` fetch it for a PR. The fork (from #226 / 0054's deferred set):
   a **GitHub Actions run artifact** (ephemeral, `gh api`-fetchable, free), a
   **PR-attached manifest comment** (durable, human-visible, size-limited), or **R2**
   (durable, we own it, needs a bucket — the imge store, ADR
   [0044](0044-imge-media-architecture.md)).
2. **Schema versioning** — a `schemaVersion` field (already in the 0054 §2 contract) plus
   the policy for how the manifest evolves past v1.

This is the missing prerequisite the CI producer (#245) needs (it persists the bundle
*somewhere*) and the gate consumers (#246 `ship-it`, #247 `review-code`) need (they fetch
the bundle *from somewhere*). Until it's settled, those three children share a hidden,
unresolved dependency.

The bundle's access profile is narrow and decides the fork: it is produced **by a CI run
on a PR's head SHA**, consumed **at gate time on that same open PR**, and irrelevant once
the PR merges (the merge commit *is* the durable record; the bundle was the proof that
justified it). It is therefore a **transient, per-run, gate-scoped** artifact, not a
long-lived asset anyone browses later. crabbox itself already emits its run output as
collectable artifacts, and the producer (#245) is already a `.github` workflow step — so
the run that creates the bundle is itself a GitHub Actions run.

## Decision

**1. The bundle is persisted as a GitHub Actions run artifact.** The CI producer (#245)
writes the assembled manifest (and its referenced logs/JUnit) to a path and uploads it via
`actions/upload-artifact` under a **fixed, well-known artifact name** — `run-evidence` —
from the workflow run triggered on the PR's head SHA. No new infrastructure: no R2 bucket,
no worker binding, no comment thread. The artifact is the native byproduct of the run that
produces it, scoped to exactly the run whose evidence it carries, and free.

**2. A gate fetches the bundle by resolving the PR's head-SHA run, then downloading its
`run-evidence` artifact — all via `gh api` REST.** Concretely, for PR `#N`:

```bash
PR=<N>
HEAD_SHA=$(gh api repos/kamp-us/phoenix/pulls/$PR --jq '.head.sha')

# the workflow run for this exact head SHA (not a stale earlier push)
RUN_ID=$(gh api "repos/kamp-us/phoenix/actions/runs?head_sha=$HEAD_SHA&per_page=100" \
  --jq '[.workflow_runs[] | select(.name=="<evidence workflow>")]
        | sort_by(.created_at) | last | .id')

# the run-evidence artifact's id, then the manifest bytes
ART_ID=$(gh api "repos/kamp-us/phoenix/actions/runs/$RUN_ID/artifacts" \
  --jq '.artifacts[] | select(.name=="run-evidence") | .id')
gh api "repos/kamp-us/phoenix/actions/artifacts/$ART_ID/zip" > /tmp/run-evidence.zip
# unzip → manifest.json → jq the 0054 §2 fields
```

`ship-it` (#246) runs this *before* merging and fails closed if the artifact is missing,
the run isn't for the head SHA, or any required `checks[]` entry isn't `pass` — additive to
the PASS-marker read (ADR [0048](0048-ship-it-merge-actor.md)) and the CI-green read, per
0054 §3. `review-code` (#247) runs the same fetch to cite structured `tests`/`coverage`.
**The head-SHA filter is the load-bearing step** — it is what makes the evidence
commit-bound, closing 0054's stale-run gap; a gate must resolve the run *by `head_sha`*,
never just "the latest run on the branch."

**3. The manifest is versioned by its `schemaVersion` field; v1 is `"1"` and its fields are
exactly ADR 0054 §2.** Evolution policy:

- **Additive changes** (a new optional field) **keep `schemaVersion` and don't break
  consumers.** Gates read only the fields they assert on and ignore unknown keys; a
  producer may add fields ahead of any consumer using them.
- **Breaking changes** (rename/remove/retype a field, or change a field's meaning)
  **bump `schemaVersion`** (`"1"` → `"2"`) and are recorded as a new ADR that supersedes the
  relevant part of 0054 §2.
- **A consumer asserts the major version it understands** — a gate reads `schemaVersion`
  first and **fails closed on an unrecognized major** rather than silently misreading a
  newer shape. This makes a producer/consumer version skew a *visible gate failure*, not a
  trust hole.

The `schemaVersion` field is a plain string major version (`"1"`), not semver — the bundle
is an internal contract between two control-plane skills and a CI step, so a single
monotonic integer carries all the compatibility signal it needs.

## Consequences

- **Zero new infrastructure.** No R2 bucket, no `Cloudflare.R2Bucket` binding in
  `alchemy.run.ts`, no comment-thread pollution. The CI-producer child (#245) has no hidden
  prerequisite beyond an `actions/upload-artifact` step it already needs; the gate children
  (#246/#247) fetch with `gh api`, the same REST surface every pipeline skill already uses.
- **Evidence is commit-bound by construction.** Resolving the run by `head_sha` ties the
  bundle to the exact commit being merged — the gate cannot be fooled by a stale green run
  from an earlier push, which was the core gap 0054 set out to close.
- **R2 is explicitly rejected for this, and the rejection is the cheap-to-revisit kind.**
  R2 (ADR 0044's store) is durable and ours, but the bundle is transient and gate-scoped —
  durability past merge buys nothing here, while a bucket + binding + key scheme + lifecycle
  is real cost for a throwaway input. If a future need appears for **cross-run** or
  **post-merge** evidence retention (an audit trail of historical bundles, dashboards over
  past runs), R2 becomes the right home and this decision is superseded by a new ADR — the
  producer would dual-write or switch its persistence target, and the gate's fetch (step 2)
  is the only consumer to update. The artifact choice does not foreclose R2; it declines to
  pay for it before there is a durability requirement.
- **PR-comment transport is rejected.** A manifest-in-a-comment is human-visible but
  size-limited (logs/JUnit don't fit), pollutes the review thread, and would need the same
  author-binding rigor as the PASS marker (ADR [0051](0051-author-bind-pass-marker.md)) to
  not be forgeable — strictly more machinery than a run artifact for less capability.
- **Artifact retention is a bounded operational knob.** GitHub expires run artifacts
  (default 90 days; repo-configurable). This is a non-issue for the gate (it reads the
  artifact within the same PR's lifetime, minutes-to-days after the run) but means the
  bundle is **not** a long-term record — reinforcing that the merge commit, not the bundle,
  is the durable artifact.
- **Schema skew fails loud.** Because a consumer fails closed on an unrecognized
  `schemaVersion` major, a producer that ships a breaking bump before the gates are updated
  blocks merges (visibly) rather than letting a gate misread the bundle and pass on bad
  evidence — fail-closed, consistent with 0054 §3.
- **Control-plane merge routing unchanged.** This ADR is `.decisions/**` (non-blocking,
  `review-doc`-gated). The producer touches `.github/**` and the consumers touch `.claude/**`
  — both blocking per ADR [0053](0053-control-plane-boundary.md), so those implementation
  PRs stay human-merged. This decision is the record they build against; it ships no code.
