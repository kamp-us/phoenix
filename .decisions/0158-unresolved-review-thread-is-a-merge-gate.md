---
id: 0158
title: An unresolved inline review thread (human or bot) is a merge gate — ship-it reads it and routes back by default, never auto-dismisses
status: accepted
date: 2026-07-05
tags: [pipeline, ship-it, review-code, control-plane]
---

# 0158 — An unresolved inline review thread is a merge gate

## Context

The merge gate silently discards inline review comments before merge — and not just the
bot's. A **human** inline `"fix this"` (left inline rather than as a formal
Request-Changes) is merged past unread exactly as a bot's lint finding is. Neither
[`review-code`](../claude-plugins/kampus-pipeline/skills/review-code/SKILL.md) nor
[`ship-it`](../claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md) ingests any
**unresolved inline thread** as a merge signal, so a reviewer's substantive objection is
treated as noise and auto-shipped over. The failure is **silent** — nothing surfaces that
a thread was dropped — which is the dangerous part. The grounded instance: the
code-quality bot's unresolved unused-import thread on PR #2113 shipped past CI +
`review-code` + `ship-it` (issue #2121 closed exactly that one biome special case; #2123
is this broadened root-cause parent).

Inline comments are where much of real human review happens. A pipeline that honors only a
formal Request-Changes and ignores inline threads gives a human who leaves a real
objection inline **no guarantee it blocks the merge** — which erodes trust in the gate the
whole autonomous-merge pipeline rests on.

The founder settled the **principle** this session (not open for re-litigation here):
*resolving every conversation thread enforces the pipeline no matter what.* The
**whether** is decided — require-conversation-resolution **plus** ship-it-reads-unresolved-threads,
with the default erring toward **routing-back**. This ADR records that settled principle
and works out the **mechanism**.

### The load-bearing crux — route back by default, never auto-dismiss

A shipper that "resolves" a human's real objection just re-creates the throw-away one layer
down. So the default **must** err toward addressing / routing-back, **never** auto-dismiss.
This is the constraint the mechanism honors, not an optimization to trade away.

### Grounded finding — where "require conversation resolution" gates the merge queue

phoenix merges via the merge queue (ADR
[0132](0132-merge-queue-for-base-freshness.md)); §CP PRs enter it too after a
control-plane-team approval (ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)). A
verification pass (GitHub docs + phoenix's live ruleset state) established, at
medium-high confidence:

- GitHub's **"Require conversation resolution before merging"** is a **PR-level
  branch-protection admission condition**. It gates the merge queue at **ENQUEUE /
  admission** — evaluated *before* the queue adds the PR — **not** at the queue's final
  batch merge (the queue re-runs only the required **status checks** against the
  `gh-readonly-queue/...` batch ref, and conversation-resolution is not a status check).
  So it *is* a real server-side gate on phoenix's queue path, complementing `ship-it`
  rather than being superseded by it.
- phoenix gates via ruleset `17377992`; conversation resolution is the `pull_request`
  rule's `required_review_thread_resolution`, currently **`false` (OFF)**.
- **Caveat (recorded, not resolved here):** phoenix enqueues via `gh pr merge --auto`, and
  that admission path had a **2022 bypass bug** where `--auto` could enqueue past an
  unresolved thread (GitHub reported it fixed). The **definitive live test** — enable the
  setting, open a throwaway PR with one unresolved thread, confirm it cannot enqueue — is
  **founder-gated** and must be run before the ruleset flag is trusted as the sole gate.

### The read-mechanism tension — REST-only vs. thread resolution state

`ship-it`/`review-code`/`report` mandate **REST-only** (`gh api` REST, never GraphQL — the
org's legacy Projects-classic integration breaks GraphQL issue/PR queries; ADR
[0062](0062-repo-as-config-plugin.md)). But inline-thread **resolution** state
(`isResolved`) is natively a **GraphQL** field
(`repository.pullRequest.reviewThreads[].isResolved`); REST's
`GET /repos/{o}/{r}/pulls/{n}/comments` exposes the inline comments but has **no**
`isResolved` field and no thread grouping, so it cannot distinguish resolved from
unresolved. This is a real tension: the required read is not available over the REST
surface the org otherwise mandates.

**Grounded resolution (verified live, read-only, against real phoenix PRs):** the
GraphQL `reviewThreads { isResolved }` query **works cleanly** on this org — it returned
exit 0 with valid data on PRs #2113, #2122, #2107 (e.g. PR #2113 returned
`isResolved: false` for the exact unresolved bot thread that shipped past the gate). The
Projects-classic breakage is **scoped to Projects fields**, not to `reviewThreads`. So the
REST-only rule needs a **documented, narrow exception for this one read**: reading review
**thread resolution** state is the single sanctioned GraphQL read in the pipeline, because
REST does not expose `isResolved` at all. This is grounded in a real observation against
the live API (the "ground platform claims in source / a real test" rule), not intuition.

## Decision

1. **An unresolved inline review thread — human or bot — is a merge gate.** Two
   independent mechanisms, defense in depth:

   - **Platform-native (server-side):** enable the ruleset's
     `required_review_thread_resolution` so GitHub blocks **enqueue** while any inline
     thread is unresolved (ADR 0132 queue path; gates at admission). **This flag flip is
     founder-gated and is NOT part of this ADR's implementation** — see Consequences.
   - **Pipeline-native (`ship-it`):** before enqueue, `ship-it` **reads** the PR's
     unresolved inline threads and acts on them, so the pipeline enforces the principle
     even before the flag is flipped (and remains correct on any repo where the ruleset
     lever is absent, ADR 0062).

2. **The read mechanism is the GraphQL `reviewThreads { isResolved }` query — the one
   sanctioned GraphQL read in the pipeline.** REST does not expose thread resolution
   state, and GraphQL `reviewThreads` is verified to work on this org (the Projects-classic
   breakage is scoped to Projects fields). This is a **narrow, documented exception** to
   the REST-only rule, for **this read only**; every other pipeline read/write stays REST.

3. **Default is route-back, never auto-dismiss (the crux).** `ship-it` classifies each
   unresolved thread:

   - **Substantive** (a real objection: "this is wrong", "handle this case", "don't do
     X") → **refuse to ship, route back to a coder** — treated exactly like a FAIL. The
     PR does not enqueue; the thread stays unresolved for `write-code` to address.
   - **Genuine nit** (a trivial, already-satisfied, or obsolete note) → `ship-it` may
     **resolve-with-explicit-rationale**: post a reply stating *why* it is a nit and
     resolve the thread. **Never** a blanket auto-resolve to clear the gate.
   - **When in doubt, treat the thread as substantive and route back.** The bias is
     deliberately conservative: a false route-back costs one cycle; a false auto-resolve
     silently discards a real objection — the exact failure this ADR closes.

4. **`review-code` surfaces unresolved inline threads in its verdict.** At review time the
   gate reads unresolved threads and lists them in the per-criterion verdict table so an
   unresolved substantive thread is **visible as a `[FAIL]` row** — making the objection
   surface *at the gate*, not silently at merge. This keeps the same conjunctive
   verdict computation (one FAIL fails the gate).

## Consequences

- **Objections stop being silently discarded.** A human's inline "fix this" and a bot's
  inline finding both now block the merge until addressed or explicitly dismissed as a
  nit — the trust hole (#2123, parent of #2121) is closed at the root, not just for the
  unused-import special case.

- **Sequencing is load-bearing — the flag flip comes AFTER `ship-it` can resolve threads.**
  Enabling `required_review_thread_resolution` *before* `ship-it` can resolve nits would
  **deadlock the pipeline on every unresolved bot comment** (every lint nit would block
  enqueue with nothing able to clear it). So this ADR + PR build the **capability**
  (`ship-it` reads + routes/resolves; `review-code` surfaces); the **founder flips the
  ruleset flag** as a separate, gated step, after confirming the capability is live. The
  PR does **not** touch ruleset settings.

- **The `--auto` bypass caveat must be live-tested before trusting the flag alone.** The
  2022 `gh pr merge --auto` bypass (GitHub reported fixed) means the platform gate is not
  trusted as the *sole* gate until the founder runs the definitive test (enable → throwaway
  PR with an unresolved thread → confirm it cannot enqueue). Until then, `ship-it`'s
  pipeline-native read is the load-bearing enforcement; the two are defense in depth.

- **One narrow GraphQL exception is now sanctioned.** Reading review-thread `isResolved`
  is the single pipeline read that uses GraphQL, documented at its use site with the
  grounding (verified working on this org; REST exposes no `isResolved`). Everything else
  stays REST-only. A future migration off Projects-classic does not change this — GraphQL
  `reviewThreads` already works; the exception is about *why* GraphQL is used here despite
  the REST-only default.

- **`ship-it` gains a judgment call it did not have** (substantive vs. nit). This is a
  *conservative* judgment — the default is route-back, so the failure mode is an extra
  cycle, never a discarded objection. The nit-resolve path always leaves a written
  rationale reply, so a human can audit every resolution.

- **This is §CP.** The PR edits gate-critical skills
  (`ship-it/SKILL.md`, `review-code/SKILL.md`), so it stops at reviewed-ready for a human
  (control-plane-team) merge (ADR 0135) — it does **not** auto-ship, and it weakens no
  existing gate invariant (the new read is an *additional* pre-enqueue refusal layered on
  the existing guard sequence).

## Vocabulary impact

**Term coined: "unresolved review thread" as a merge gate signal** — an inline review
thread (human or bot) whose `isResolved` is false, now a first-class merge-blocking signal
alongside the formal `review-*: FAIL` verdict. And the **substantive-vs-nit** thread
classification (`ship-it`'s route-back-vs-resolve-with-rationale disposition). These are
narrow, self-defining pipeline mechanics recorded here at their coining site; they extend
the existing gate vocabulary rather than introducing a new domain noun, so no
`.glossary/TERMS.md` row is added in this PR — the definitions live in this ADR and at the
skills' use sites. Recorded outcome: **no `.glossary/TERMS.md` change** (mechanic extension
of the already-named gate/verdict vocabulary).
