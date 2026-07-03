---
id: 0132
title: Adopt GitHub merge queue for base-freshness at merge
status: accepted
date: 2026-07-02
tags: [pipeline, github-actions, ci, merge]
---

# 0132 — Adopt GitHub merge queue for base-freshness at merge

## Context

Resolves triaged issue [#772](https://github.com/kamp-us/phoenix/issues/772) (child of epic [#765](https://github.com/kamp-us/phoenix/issues/765)).

The pipeline has a **base-freshness gap at merge time**. GitHub Actions `pull_request` events already check out `refs/pull/N/merge` — the prospective merge of the PR head into the base — and the `ci-required` roll-up (`.github/workflows/ci.yml`) gates merge on that. But that merge ref is computed against the base *as of the PR's last CI run*. If the base advances after that run (a sibling PR merged), the tested merge ref is **stale**: green-on-branch no longer proves green-on-merge. For an autonomous multi-PR pipeline merging concurrently, this is the routine case, not an edge case.

Issue #772 named two candidate mechanisms — strict required-status-checks ("require branches up to date") vs a merge queue — and asked us to pick based on the pipeline's real merge concurrency and record the throughput trade-off.

## Decision

Adopt **GitHub's merge queue** to guarantee base-freshness at merge, over strict "require branches up to date" and over the status quo.

The merge queue tests the **actual prospective batched merge result** on a temporary branch (`gh-readonly-queue/<base_branch>/…`) that combines the PR's changes with the latest base *and* the changes of PRs ahead of it in the queue, and merges to the base only once the branch-protection-required checks pass on that combined ref (GitHub docs, [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) — "GitHub will merge all these changes into the `base_branch` once the checks required by the branch protections of `base_branch` pass"). This is base-freshness by construction: nothing lands on the base whose CI did not run against the base it actually merges onto.

### Why the merge queue over strict "require branches up to date"

Strict required-status-checks would also close the gap — it forces the PR branch up to date onto the current base before merge, re-running CI on a fresh merge ref. But under an autonomous pipeline with several PRs green and mergeable at once, it degenerates into a **serialize-rebase treadmill**: every base advance (each sibling merge) invalidates the "up to date" state of *every* other open PR, forcing an update + full CI re-run on each before it can merge. N concurrently-ready PRs cost an update-and-re-run storm that grows with N, and each re-run can be invalidated again by the next merge before it finishes — a livelock-prone treadmill that throttles the exact concurrent-merge throughput the pipeline is built for.

The merge queue tests the **batched** prospective result instead of serializing one-rebase-per-merge: multiple queued PRs are validated together on one combined ref and merged first-in-first-out once that ref is green, so throughput under concurrent merges is far better. Given the pipeline's real merge concurrency (multiple gated PRs ready at once is the design point, not the exception), the queue is the right mechanism and the added setup cost is worth it. This is the throughput trade-off #772 asked to record: **higher setup cost, materially better throughput under concurrency**; strict checks are simpler but throughput-hostile for this workload.

## Consequences

### The async-merge shift — the merge actor reports QUEUED, not MERGED

The merge queue owns the **final** merge: it merges to the base server-side once the batched ref is green, which happens **asynchronously** after the actor acts. So the merge actor's success condition changes:

- **Before:** "merged now + linked issue auto-closed, confirmed in the same run."
- **After:** "successfully **enqueued** + all gates green" — the queue performs the final merge later, and the `Fixes #N` issue-close therefore moves **async** (it fires when the queue completes the merge, not in the actor's run).

`ship-it` and the `drive-issue.js` shipper stage now assert **enqueued + green** and report **"QUEUED → auto-merges on green"** rather than asserting `merged=true` + issue-closed in-run. Every existing gate is **preserved unchanged** — the §CP control-plane refusal, the SHA-bound-verdict guard, the CI-green guard, the run-evidence-bundle guard, and the single-merge-authority contract (ADR [0048](0048-ship-it-merge-actor.md)) all still hold. The **only** two changes are the merge *mechanism* (immediate squash → enqueue-for-squash) and the *success condition* (merged → enqueued + green). No gate is weakened or removed.

### CI-under-batch — gating workflows gain `merge_group:` triggers

A merge queue **waits for its required checks to be reported on the `merge_group` batch ref before it can merge**, and those checks only run if the workflow is triggered by the `merge_group` event (GitHub docs, [Configuring CI for merge queues](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue#triggering-merge-group-checks-with-github-actions) — "You **must** use the `merge_group` event to trigger your GitHub Actions workflow when a pull request is added to a merge queue"). Without a `merge_group:` trigger the queue never receives the required check on the batch → **every** merge hangs.

So each workflow that produces a **merge-gating** check gains a `merge_group:` trigger alongside its `pull_request:` trigger:

```yaml
on:
  pull_request:
  merge_group:
```

The **gating** workflows are exactly those producing a **branch-protection-required** status check. The "main protection" ruleset requires three contexts (`gh api repos/kamp-us/phoenix/rulesets/17377992`): `ci-required`, `validate skill frontmatter`, and `scan changed files for leaks`. They come from **two** workflows, both of which gain the `merge_group:` trigger:

- `ci.yml` — produces **both** `ci-required` (the roll-up over every job it depends on; a batch-ref run computes it over the batched changes) **and** `validate skill frontmatter` (the `skills` job).
- `leak-guard.yml` — produces `scan changed files for leaks`. Its `scan` job resolves the base from `github.base_ref` on `pull_request` and from `github.event.merge_group.base_sha` on the batch ref, so its `base...HEAD` diff is correct on both events.

`run-evidence.yml` also gains the trigger: it is not itself a branch-protection-required *context*, but it produces the SHA-bound run-evidence bundle the gates in `ship-it`/`review-code` assert against the batch head, so it must run on the batch ref for those gates to resolve.

Non-gating PR-metadata workflows (doc-links, decisions-index, pointer-guard, readme-guard, codeowners-cp, workflow-contract, glossary-drift) do **not** get the trigger: a check that does not gate merge has no reason to run on the batch, and adding it would only slow the queue.

The `merge_group` ref (`gh-readonly-queue/<base>/…`) is a real branch push. A workflow that keys on the PR head SHA (run-evidence stamps `github.event.pull_request.head.sha` on `pull_request`) binds to `github.event.merge_group.head_sha` on the `merge_group` event — the batch head, the exact commit that merges — rather than `github.event.pull_request.head.sha` (empty on the batch ref). `run-evidence.yml` threads exactly this `${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}` into `HEAD_SHA`, the `--commit` stamp, and the fail-closed drift assert.

### Transition safety — this PR is safe under the CURRENT direct-merge path

`gh pr merge --squash --auto` works in **both** regimes:

- **Pre-queue (today, no queue required):** `--auto` enables auto-merge — the PR merges when its required checks pass (GitHub docs, [Automatically merging a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)). Same terminal merge as today's bare `--squash`, just triggered on green instead of immediately.
- **Post-queue (once "require merge queue" is on):** enabling auto-merge **adds the PR to the queue** once requirements are met; the queue performs the batched merge.

So `--auto` is the **universal-safe** change: the pipeline edits in this ADR (ship-it, drive-issue.js, the shipper agent doc, the `merge_group:` triggers) land **first** and do **not** break current merges. The branch-protection **"require merge queue" toggle is a separate, last, human-only administrative step** (the founder's admin action on branch protection / rulesets), explicitly **not** part of the code change this ADR accompanies. Until that toggle flips, `--auto` behaves as ordinary auto-merge; after it flips, the same command enqueues — no code change re-flips between the two.

## References

- Issue [#772](https://github.com/kamp-us/phoenix/issues/772), child of epic [#765](https://github.com/kamp-us/phoenix/issues/765).
- ADR [0048](0048-ship-it-merge-actor.md) — ship-it is the single merge authority (preserved).
- ADR [0053](0053-control-plane-boundary.md) — the §CP control-plane boundary (preserved; §CP PRs still refuse to self-merge).
- ADR [0054](0054-run-evidence-bundle.md) / [0056](0056-bundle-storage-transport.md) — the run-evidence bundle gate (preserved; its producer gains `merge_group:`).
- Issue [#312](https://github.com/kamp-us/phoenix/issues/312) — the leak gate (`scan changed files for leaks`), a branch-protection-required check whose producer (`leak-guard.yml`) gains `merge_group:`.
- GitHub docs — [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) and [Automatically merging a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request).

## Addendum — merge-queue operational corrections (2026-07-03, [#1824](https://github.com/kamp-us/phoenix/issues/1824))

The decision above stands, but rolling it out to a live merge queue surfaced two operational facts the original text got wrong or omitted. This addendum records them; it does **not** revise the accepted decision (the merge queue remains the chosen mechanism). Both are stated repo-agnostically so a foreign install adopting this ADR via the plugin path (ADR [0062](0062-repo-as-config-plugin.md)) inherits the corrections, and both name the literal failure strings so a future operator can grep the exact symptom back to this addendum.

### 1. `allow_auto_merge=true` is a HARD PREREQUISITE of the merge-queue regime

The repo setting **"Allow auto-merge" (`allow_auto_merge`)** — Settings → General → Pull Requests → *Allow auto-merge* — **must be enabled** for the enqueue path in "The async-merge shift" (§Consequences) to work **at all**. It is the sibling admin prerequisite to the "require merge queue" ruleset toggle the decision already documents, and the original text omitted it: the string `allow_auto_merge` did not appear in this ADR before this addendum. Enabling the `merge_queue` ruleset **without** also enabling `allow_auto_merge` reproduces a repo-wide silent jam — this was the [#1817](https://github.com/kamp-us/phoenix/issues/1817) outage (2026-07-03), where ~8 reviewed-ready PRs jammed at the ship-it enqueue step.

The failure is deceptively silent, not a loud error:

- `gh pr merge --auto` fails with the literal string **`Auto merge is not allowed for this repository (enablePullRequestAutoMerge)`**.
- The PR's `autoMergeRequest` / `auto_merge` field reads **`null`**, and the PR looks **QUEUED-but-not-progressing** — a no-op that presents as "stuck in the queue," not as an obvious rejection. The queue simply never receives the PR.

So a merge-queue adopter must treat `allow_auto_merge=true` as a precondition of enabling the queue, verified before the ruleset toggle flips — not discovered by trial via `gh api` after the jam.

### 2. The "`--squash --auto` works in both regimes" claim is FALSIFIED — use plain `--auto`

The transition-safety section above asserts (in *§Transition safety*, the line "`gh pr merge --squash --auto` works in **both** regimes"):

> `gh pr merge --squash --auto` works in **both** regimes

Under the merge queue this is **false**. The **queue owns the merge strategy** (it applies the squash on the batched ref), so passing an explicit method flag *conflicts* with the queue rather than cooperating with it:

- `gh pr merge --squash --auto` under the queue is rejected with **`The merge strategy for main is set by the merge queue`**.
- A REST `PUT .../merges`-style direct merge is rejected with **`405 — Changes must be made through the merge queue`**.

The **correct** enqueue invocation is plain **`gh pr merge --auto`** — **no** method flag; the queue applies the squash itself. This is why the ship-it skill was corrected from `--squash --auto` to plain `--auto`: the same command must enqueue cleanly under the queue and still act as ordinary auto-merge before the "require merge queue" toggle flips, and only the method-less form does both.

### 3. A successful enqueue leaves `auto_merge` `null` — `QUEUED` is the success signal

Reinforcing §"The async-merge shift": after a *successful* enqueue under the merge queue, the PR's `auto_merge` / `autoMergeRequest` field stays **`null`** (the queue, not an auto-merge request, owns the async merge), and **`already queued to merge`** / a **`QUEUED`** state is the success signal. Future ship-it debugging must **not** read a `null` `auto_merge` as a failure — under the queue that is the expected post-enqueue shape, indistinguishable at the `auto_merge` field alone from the correction-1 jam, which is why correction 1's failure string (not the `null` field) is the reliable jam discriminator.

### On which checks can gate the queue (deploy-dependent e2e)

One consequence for §"CI-under-batch": a **deploy-dependent** check cannot gate the queue, because a `merge_group` batch ref gets **no deploy**, so a deploy-gated e2e check has nothing to run against on the `merge_group` event (surfaced by [#1826](https://github.com/kamp-us/phoenix/issues/1826)). Only checks that run without a per-ref deploy may be added to the branch-protection-required set that gates the queue.
