---
id: 0213
title: The verdict upsert is keyed on the posting run, not the shared author — one comment per (PR, gate, run) (refines 0058 rule 2)
status: accepted
date: 2026-07-25
tags: [pipeline, verdict, review-code, concurrency, security]
---

# 0213 — The Verdict Upsert Is Keyed on the Posting Run, Not the Shared Author (refines 0058 rule 2)

**What this decides — and only this:** `verdict post` upserts one comment per **(PR, gate, posting
run)** instead of per (PR, gate, author), so a concurrent reviewer sharing our GitHub login appends
its verdict rather than PATCHing another reviewer's away. A namespace may therefore legitimately
hold more than one verdict comment at one head.

**What this deliberately does NOT decide: verdict precedence.** How a reader picks among the
verdicts in a namespace is ADR [0058](0058-sha-bound-verdict-contract.md) rule 3's business, and it
is unchanged here — latest-wins on `(createdAt, id)`, as computed by `resolveVerdict` and
`decideGate`. This ADR is about the *poster's* key, not the *reader's* order. An earlier draft of it
also legislated a "any current-head FAIL vetoes" resolution; that rule is **not** adopted — see
[Rejected: a current-head FAIL veto](#rejected-a-current-head-fail-veto).

## Context

ADR 0058 rule 2 made the verdict an **upsert**: a producer scans for *its own* prior marker in the
gate namespace and PATCHes it, so a (PR, gate) pair resolves to exactly one comment. Rule 2
justified the own-authored scope explicitly:

> The own-authored scope matters: a producer upserts only a marker it itself authored, so two
> authorized reviewers do not stomp each other's records inside one namespace

**That premise is false in this pipeline, and was false the day it was written.** Every review agent
posts under the **one shared GitHub identity** the operator's checkout carries, so "own-authored"
does not distinguish reviewers at all — it selects *any* agent's marker in the namespace. This is the
same shared-login degeneracy ADR [0115](0115-agent-distinguishable-claim-marker.md) removed from the
issue claim, where `min(login)` collapsed to a no-op because every racer resolved to the same login.

The consequence is a **silent, server-side loss of a merge-gate artifact**. Two reviewers running
concurrently against one PR at one head both match the *other's* comment and PATCH its body away.
Observed on PR #3988 at head `0368922e…`: two verdict comments carry an `updated_at` later than
their `created_at`, and the surviving `review-code` body documents the overwrite against itself
(#4016). The outcome there happened to be safe — the surviving verdict was the stricter FAIL — but
the loss is unconditional:

- The overwritten body is **destroyed, not superseded-and-visible**. An auditor sees one verdict and
  cannot tell it replaced another, or what it said.
- It never reproduces under a single poster, so no single-reviewer test sees it.

## Decision

### 1. The upsert key gains a run dimension

`verdict post` stamps every body it writes with the posting run's identity — an HTML-comment trailer,
invisible in rendered markdown:

```
<!-- verdict-run: <run id> -->
```

The run id is the agent's `CLAUDE_CODE_SESSION_ID` (overridable with `--run-id`), the same
agent-distinguishable token ADR 0115 claims work under and the one thing the shared login cannot
supply. `post` then PATCHes a prior marker only when it matches on **author *and* gate namespace
*and* this run's trailer**; anything else it appends. So a genuine same-run correction still upserts
(no comment spam for a revision of this run's own record), and a sibling run never matches.

**Absence is fail-safe, not fail-open.** A run with no resolvable run id — an unset session id, a
pre-#4016 or hand-rolled marker with no trailer — matches nothing and therefore **appends**. The
worst case is an extra comment; a verdict is never overwritten on an unproven claim of ownership.
This mirrors the claim guard's default-deny: only positive evidence of ownership authorizes the
destructive path.

### 2. Rule 2's uniqueness invariant narrows to per-run

Rule 2's invariant narrows from **exactly one comment per (PR, gate)** to **exactly one comment per
(PR, gate, run)**. Multiple verdict comments in one namespace at one head are a **legal, expected
state** whenever two reviewer runs gate the same head, not a defect to reconcile. Rule 2's "Banned:
POSTing a new marker when this gate already has one authored by this producer on this PR" narrows in
the same motion: the ban applies to *this run's* marker, never another run's.

Rules 1 (SHA-bind every verdict), 3 (refuse a SHA-unbound or stale-head verdict, latest-wins among
what remains), and 4 (`review-doc` emits only the comment) are **unchanged**. The author-gate (ADR
[0055](0055-acl-sourced-review-authz.md)) still runs ahead of every resolution.

### Rejected: a current-head FAIL veto

It is tempting to pair the append-instead-of-overwrite fix with a read-side rule that any
current-head FAIL vetoes, on the reasoning that a merge gate's two error directions are asymmetric.
**That rule is rejected**, because it re-creates a worse failure than the one it prevents.

A verdict does not only get superseded by a new head. A **body-only repair** — the reviewer's
finding is answered in the PR body, the ADR text, or the verdict record itself — deliberately does
**not** move the head, so an old FAIL at that head stays current-head-bound indefinitely. Under a
veto rule nothing can ever out-rank it and the PR is wedged with no exit: that is
[#4049](https://github.com/kamp-us/phoenix/issues/4049), and it is what latest-wins closes by
letting a newer superseding verdict (a re-review marker, or a §CP advisory) out-rank an older
same-head FAIL. PRs #3988 and #3998 both shipped through exactly that path.

So the precedence rule stays **latest-wins on `(createdAt, id)`**, applied across the marker and §CP
advisory candidate sets alike. Two reviewer runs disagreeing at one head is resolved the same way a
single reviewer's re-review at one head has always been resolved: the newer verdict is the verdict.

## Consequences

- **The cross-reviewer clobber is structurally unreachable.** A sibling run cannot select another
  run's comment, so no verdict body is destroyed server-side. Both records survive on the PR and an
  auditor can see a second opinion existed — which is the whole win, and it is a win about
  *evidence*, not about precedence.
- **The residual, stated honestly: a PASS posted after a FAIL at the same head still resolves PASS.**
  Appending stops the FAIL from being *erased*; it does not stop it from being *superseded*. That is
  the accepted trade, and it is the trade that keeps #4049 closed. The FAIL remains readable on the
  thread, which is strictly more than the pre-fix behaviour offered.
- **"A repair always pushes a new head" is false, and no rule here may assume it.** A body-only
  repair leaves the head where it is, so head-keyed staleness-invalidation (ADR 0058 rule 3) does not
  fire and cannot be relied on as the universal escape hatch from a standing verdict. This is the
  exact assumption that made the veto rule look safe; it is recorded here so the next reader does not
  re-derive it.
- **PR threads may show two verdict comments per gate at one head.** That is the intended new state,
  and it is bounded: one per gate per run, and a run that re-posts still upserts its own.
- **A verdict posted outside the tool is never upserted.** A hand-rolled marker carries no trailer,
  so the next `post` appends beside it rather than overwriting it — the safe direction, and one more
  reason to post through the tool.
- **The trailer is machine-only.** It renders invisibly, carries no path or PII, and passes every
  `emissionDefect` guard unchanged (the marker stays on line one; #2646/#2683/#2796 are untouched).
- **Not fixed here:** the *head* dimension of the same upsert key — re-gating at a new head still
  edits the prior head's verdict in place when the same run posts both. That is
  [#4007](https://github.com/kamp-us/phoenix/issues/4007), deliberately left to its own change; the
  run dimension and the head dimension are independent facets of one selection.
- **Relationship:** refines [0058](0058-sha-bound-verdict-contract.md) rule 2's uniqueness key, and
  only that — rule 3's precedence is untouched; preserves
  [0055](0055-acl-sourced-review-authz.md)'s author-gate ahead of every resolution; applies
  [0115](0115-agent-distinguishable-claim-marker.md)'s agent-distinguishable session token to a
  second shared-login surface.
