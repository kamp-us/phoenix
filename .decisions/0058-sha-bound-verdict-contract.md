---
id: 0058
title: Gate Verdicts Are SHA-Bound and One-Per-Gate (Upsert), and ship-it Refuses Stale-Head Verdicts
status: accepted
date: 2026-06-14
tags: [pipeline, skills, ship-it, review-code, review-doc, write-code, security, agents, concurrency]
---

# 0058 — Gate Verdicts Are SHA-Bound and One-Per-Gate (Upsert), and ship-it Refuses Stale-Head Verdicts

## Context

The gate verdict — a `review-code`/`review-doc` PASS/FAIL — is the signal `ship-it`
merges on and `write-code`'s repair loop consumes. Two properties of how that signal was
written and read combined into the one race in the suite that can **silently squash-merge
broken code into `main`** (#258):

1. **Verdicts were appended, not upserted.** Every reviewer run `POST`ed a *new* PR
   comment. Nothing reconciled to one-verdict-per-gate, so a (PR, gate-namespace) pair
   accumulated a growing stream of verdict comments.
2. **Consumption was timestamp-latest-wins, SHA-blind.** `ship-it` Step 2 and `write-code`
   repair resolved "the verdict" with `sort_by(.created_at) | last` per namespace. The
   comparison was purely temporal; the verdict carried **no record of the head SHA the
   reviewer actually inspected**, and the consumer never checked the verdict against the
   PR's *current* head.

Under the pipeline's normal mode — autonomous, multi-agent, two reviewers/shippers touching
one PR — this enables two distinct silent-merge hazards:

- **The masking race.** Machine A's reviewer genuinely catches a failing test and is about
  to post FAIL; machine B's reviewer (slower, or reviewing an older head) posts PASS a
  millisecond later. `ship-it` reads the newest comment, sees PASS, merges broken code. ADR
  [0055](0055-acl-sourced-review-authz.md)'s author-gate does **not** help: both verdicts are
  from authorized reviewers; a `created_at` tiebreak alone decides, and it picks wrong.
- **The head-moved race.** A PASS is posted against head `X1`; new commits push the head to
  `X2` before `ship-it` runs. `ship-it` consumes the `X1` PASS as if it covered `X2`, merging
  unreviewed code.

`review-doc` was strictly worse: its land-a-native-`APPROVE`-then-fallback-to-comment path
could leave **both** an `APPROVE` review and a contradictory `review-doc:` comment from two
machines on one PR, so even the latest-wins tiebreak was reading across two *incomparable*
record types (a review has `submitted_at`; a comment has `created_at`).

This also undercut ADR [0054](0054-run-evidence-bundle.md)'s intent: the gate trusts a
SHA-bound *run proof*, but the *verdict* that proof justified was itself unbound and
overwritable.

### Scope: which verdicts this binds

A verdict is SHA-bound only where it **reviews a specific PR head**. That is `review-code`
and `review-doc` — the PR-layer gates whose verdicts `ship-it` and `write-code`-repair
consume. `review-plan` is deliberately **out of scope**: its PASS/FAIL marker
(`packages/epic-ledger/src/gate.ts`) lives on an *epic issue*, gates a `status:planned →
status:triaged` label flip over a plan *ledger* (not a PR head), and is consumed by the
convergence loop, never by `ship-it`. There is no head SHA to bind, and binding it would
require editing the deterministic gate's code, not a skill. `heal-ci` is likewise out of
scope — it routes a CI run, it does not emit a merge-authorizing verdict.

## Decision

A gate verdict that authorizes (or vetoes) a merge is **SHA-bound, exactly-one-per-gate
(upsert, not append), and refused by the consumer when it is not bound to the PR's current
head.** Three coupled rules:

### 1. SHA-bind every PR-layer verdict

The verdict marker carries the head SHA the reviewer actually inspected, resolved at post
time:

```bash
HEAD_SHA="$(gh api repos/kamp-us/phoenix/pulls/$PR --jq .head.sha)"
```

The canonical marker shapes (recorded in
[gh-issue-intake-formats.md](../.claude/skills/gh-issue-intake-formats.md) §5/§6):

- `review-code: PASS @ <sha> — merge-ready` / `review-code: FAIL @ <sha> — not merge-ready`
- `review-doc: PASS @ <sha> — merge-ready` / `review-doc: FAIL @ <sha> — changes-requested`
- (blocking-set doc PRs keep the advisory line, which is out of `ship-it`'s namespace and
  needs no SHA — a human merges those, ADR [0053](0053-control-plane-boundary.md)).

The `@ <sha>` is the full or abbreviated (≥7 hex) head SHA. Emphasis-tolerance from #259 is
preserved: the matcher still absorbs an optional leading `**`.

### 2. Upsert, not append — one resolvable verdict per (PR, gate-namespace)

A producer (`review-code`, `review-doc`) scans the PR's comments for **its own** prior
marker comment *in this gate's namespace* and, if one exists, `PATCH`es it
(`gh api -X PATCH repos/kamp-us/phoenix/issues/comments/<id>`) instead of `POST`-ing a new
one. The result is **exactly one** marker comment per (PR, gate-namespace), carrying the
*current* verdict for the *current* head — not a growing append stream a millisecond
decides. A re-review of a new head overwrites the same comment with the new verdict + new
`@ <sha>`.

The own-authored scope matters: a producer upserts only a marker it itself authored, so two
authorized reviewers do not stomp each other's records inside one namespace — but because the
consumer (rule 3) refuses any verdict not bound to the *current* head, only the reviewer who
inspected the live head can produce a consumable verdict anyway. The masking race collapses:
a stale PASS bound to an older head is `unverified`, not a PASS that outranks a real FAIL.

### 3. ship-it (and write-code-repair) refuse a SHA-unbound or stale-head verdict

The consumer resolves each gate's latest verdict exactly as before — **keeping the ADR-0055
ACL author-gate and the #259 emphasis-tolerance, in that order** — then parses the verdict's
`@ <sha>` and **refuses to merge unless that sha equals the PR's current head sha**:

```bash
CURRENT_HEAD="$(gh api repos/kamp-us/phoenix/pulls/$PR --jq .head.sha)"
```

- A verdict whose `@ <sha>` is a **prefix-or-equal** match of `CURRENT_HEAD` (either may be
  abbreviated) → bound to the current head → its polarity decides as before.
- A verdict with **no `@ <sha>`** (a legacy/pre-0058 marker) → `unverified (verdict not bound
  to current head)` → refuse.
- A verdict bound to a **different (older) head** → `unverified (verdict not bound to current
  head)` → refuse.

A native approving review needs no marker SHA: GitHub records the review's `commit_id`, which
is itself the SHA the reviewer approved. `ship-it` treats a native `APPROVED`/`CHANGES_REQUESTED`
review as current iff its `commit_id` prefix-matches the current head — the same staleness
test, sourced from GitHub's own author-bound record.

### 4. review-doc emits the SHA-bound comment, never a native APPROVE

The native-`APPROVE`-vs-comment duality is resolved to **one comparable verdict form: the
SHA-bound comment marker.** A native GitHub review *cannot carry the `@ <sha>` in a shape
this contract controls* (it records `commit_id` separately, in a different record type than a
comment), so a suite that needs `review-code` and `review-doc` to resolve identically must
not leave `ship-it` comparing a review against a comment for the doc lane. `review-doc`
therefore lands its verdict **only** as the SHA-bound `review-doc:` comment (upserted per
rule 2) and never posts a native `APPROVE`/`REQUEST_CHANGES`. This is exhaustive across
`review-doc`'s outcomes: the blocking-set **advisory** line (the only `review-doc` output
that carries no `@ <sha>`, since no `ship-it` namespace consumes it — a human merges those,
ADR [0053](0053-control-plane-boundary.md)) is **also** a comment, never a native review, so
the "never a native review" invariant holds on every `review-doc` path with no carve-out.
`review-code` keeps its native
approving-review path (it is the preferred, unforgeable GitHub signal where it can be posted,
and `ship-it` reads its `commit_id` for the staleness test), with the SHA-bound comment as
the load-bearing fallback for the operator's own PR (org branch rules block self-`APPROVE`).

## Consequences

- **Both races closed at once.** A slower PASS can never silently overwrite a real FAIL on
  the same head (upsert + own-authored scope), and a PASS bound to an older head can never be
  consumed against a newer head (SHA-bind + refuse-on-mismatch). The masking race and the
  head-moved race are the same fix.
- **One record per gate.** A (PR, gate-namespace) pair resolves to exactly one verdict
  comment, not an append stream — `ship-it`/`write-code` read a single current record, and
  the PR comment thread stops accumulating stale verdicts.
- **review-doc is comparable.** `ship-it` no longer compares a native review against a
  comment for the doc lane; both lanes resolve a SHA-bound comment the same way.
- **Legacy markers fail closed.** A pre-0058 SHA-less marker resolves to `unverified`, not a
  silent PASS — the safe direction. The remedy is a re-review (which now emits a SHA-bound
  marker), not a merge on an unbindable verdict.
- **New cost.** The consumer makes one extra `gh api …/pulls/$PR --jq .head.sha` call (cheap;
  `ship-it` already fetches the PR). The producer makes one extra comments-scan to find its
  own prior marker to PATCH. A transient lookup failure fails closed → refuse → re-run
  resolves it, consistent with ADR 0055.
- **Banned:** posting a verdict marker without `@ <sha>`; `POST`ing a new marker when this
  gate already has one authored by this producer on this PR (append instead of upsert) —
  forward-looking only: lingering SHA-less own-markers left by the pre-0058 append era are
  tolerated, since the upsert PATCHes just the newest and the consumer SHA-refuses the rest;
  consuming a verdict whose `@ <sha>` does not prefix-match the PR's current head; `review-doc`
  emitting a native `APPROVE`/`REQUEST_CHANGES`; comparing a native review against a comment in
  the doc lane.
- **Scope — every PR-layer producer and consumer migrates in this change.** `review-code` and
  `review-doc` (producers, rules 1/2/4), `ship-it` Step 2 and `write-code` repair Step R1
  (consumers, rule 3), and the §5/§6 formats contract move together; no transitional split.
  `review-plan`/`heal-ci` are explicitly excluded (see Context → Scope).
- **Relationship:** builds on [0055](0055-acl-sourced-review-authz.md) (the ACL author-gate
  is preserved and runs *before* the SHA-staleness test) and on #259's emphasis-tolerant
  matcher (preserved, now extended to capture the SHA); extends
  [0048](0048-ship-it-merge-actor.md) (refines *which* verdict the single merge authority
  consumes — a current-head-bound one, not merely the latest); realizes the SHA-bound intent
  ADR [0054](0054-run-evidence-bundle.md) established for the run proof, now extended to the
  verdict the proof justifies. As a `.claude`/`.decisions` control-plane change, this ADR and
  its skill edits are **human-merged** per ADR [0053](0053-control-plane-boundary.md); the
  pipeline does not self-merge changes to its own merge authority.
