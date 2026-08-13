---
id: 0276
title: A fabrika review verdict binds content, not only the head SHA
status: accepted
date: 2026-08-13
tags: [fabrika, review, ship, verdict, merge-authority, decisions]
---

# 0276 — A fabrika review verdict binds content, not only the head SHA

**What this decides:** A fabrika `review-*` / `governance` verdict now survives a branch update when the diff *and* the resulting content of every changed file come out byte-identical. It dies on anything else. The trade: a change on the base branch that touches no reviewed path no longer invalidates the verdict, and that residual is stated below rather than left implied.

## Context

This records a founder ruling given 2026-08-13 on [#5508](https://github.com/kamp-us/phoenix/issues/5508). It amends fabrika's own verdict contract. It does **not** amend v1's ADR [0058](0058-sha-bound-verdict-contract.md), which stays as written for `packages/pipeline-cli/` — fabrika reimplements and never calls v1 (ADR [0238](0238-fabrika-reimplements-v1-never-calls-it.md)), so the two contracts are separate documents with separate scopes.

### The cost that opened it, first-party

The reviewed artifact is `git diff <base>...<head>` — **three dots** (`packages/fabrika-cli/src/io/git.ts`). A three-dot diff is already invariant under an update-from-main: the merge base moves forward, the head absorbs main's commits, and what the branch adds since it diverged comes back byte-identical. On 2026-08-13 two §CP-approved PRs (#5493, #5494) had to be updated from main purely to pick up a workflow demotion, and the head move invalidated verdicts over content nobody had changed. The founder hand-merged rather than pay the re-review. That is real waste, not a misreading.

### The head SHA was doing two jobs, and only one of them was over-broad

- **It invalidates on branch pushes.** Over-broad: a push that leaves the reviewed artifact identical forces a re-review of nothing.
- **It invalidates on base drift.** Not over-broad: the merged result is `base + diff`, and when the base moves, `base + diff` is a combination nobody looked at.

A digest over the three-dot diff *alone* would take the first job and silently drop the second — it is invariant across a base move by construction. That is why the triage note refused a plain diff digest as fail-open. The ruling's answer keeps both jobs by binding a second thing alongside the diff.

## Decision

A fabrika verdict marker carries an optional **content digest** beside its head SHA:

```
review-code: PASS @ 03135b91 content:2f1a9c4e0b7d — merge-ready
```

**What the digest covers.** The first 12 hex of the SHA-256 of a canonical serialization of `git diff --raw <base>...<head>` (`packages/fabrika-cli/src/review/content-binding.ts`). One raw record per changed path names the path, the change letter, both modes, and **both blob object names** — the source blob in the merge base and the **destination blob at the head**. Digesting those records binds both of the ruling's legs at once, and a reader can falsify that claim directly:

- **The three-dot diff**, because a unified diff is a function of the endpoint blobs and the pinned diff flags and of nothing else.
- **The resulting content of every changed file**, because the destination blob object name *is* that content.

**What it decides.** A verdict is in force when the head has not moved (unchanged), **or** when the head has moved and this head's digest equals the one the verdict carries. Anything else is stale.

**Which job it keeps and which it drops.**

| Job the head SHA did | After this ruling |
| --- | --- |
| Invalidate on a branch push that changes the reviewed artifact | **Kept**, by the digest. |
| Invalidate on a branch push that changes nothing reviewed | **Dropped, deliberately.** This is the re-review tax the ruling removes. |
| Invalidate on base drift that reaches a reviewed path | **Kept.** A merge from main into a file the PR touches changes that file's destination blob, so the digest moves. This is the leg a diff-only digest would have lost. |
| Invalidate on base drift that reaches no reviewed path | **Dropped.** See the residual below. |

### The base-drift residual, stated out loud

A commit landing on the base branch that touches **no path the PR changes** leaves the digest equal, so the verdict survives it. The reviewer never saw that commit, and the merged result contains it. The risk is a change on main that interacts with the reviewed diff without sharing a file with it — a helper whose behaviour changes under the caller the PR added, a config the PR's new code reads.

This is accepted, not overlooked. Three things bound it:

1. **It is bounded by file, not by nothing.** The old rule caught this only as a side effect of catching *everything*; the new rule still catches every base change that lands in a reviewed file.
2. **Nothing else in the stack was relying on the dropped leg.** CI runs against the merge result, and the merge queue re-runs it — a semantic break from an unrelated main commit reds there, at the layer that actually executes the combination. A human reading a diff was never the detector for it.
3. **The safe direction stays available.** Any reviewer who wants the old behaviour posts a marker with no content field; the absence of the field is head-only binding, and no verb can add one after the fact.

### The §CP half is #3769's, carried not re-decided

The human approval `ship` consumes is **untouched**. GitHub re-binds its own review objects and its dismissal settings are a repo-settings layer; [#3769](https://github.com/kamp-us/phoenix/issues/3769) is the open p0 that owns whether a patch-identical head preserves a §CP approval, and it warns on its own face that adjacent binding questions ruled separately produce answers that do not compose. So:

- The §CP **advisory** carrier emits no content field and stays head-bound (`packages/fabrika-cli/src/ship/gate-verb.ts`).
- The native GitHub **review fold** likewise.
- `claude-plugins/fabrika/skills/ship/SKILL.md`'s `NO-REBASE-AFTER-APPROVAL` anchor stays in force, narrowed in the same change to say which half it governs — a skill asserting the reverse of the live rule is worse than either rule.

## Consequences

**Absence of a binding is never a binding.** A marker with no content field falls back to head equality — the pre-ruling answer, and strictly the stricter one. A legacy marker, a hand-written one, and a typo'd one all resolve that way, so nothing gains survival it did not earn. A `content:` token that reaches for the field and misses reads `Malformed`, never as a head-only marker.

**The three tokens still do not fold.** `bindToContent` answers `Current` / `Stale` / `Unbindable` with the same discipline `bindToHead` has: a caller that could not compute this head's digest gets `Unbindable`, never `Current` and never `Stale`, because a comparison that could not be made is not a result in either direction. Consumers must block on `Unbindable` as they block on `Stale`; `ship gate` does, and names the reason on stderr so an operator can tell a broken checkout from a real re-review.

**The gate's git read is lazy, and its failure can only refuse.** `ship gate` reads `--raw` only when a content-bound verdict has *already* failed the head test. Every verdict at this head costs no git at all. A checkout that cannot answer leaves the digest unknown, the namespace resolves `stale`, and that is exactly the block this verb gave before the ruling — so the new read cannot wedge a merge that would previously have passed.

**The in-force ordering is deliberately not widened.** `inForce` still gives the head-bound tiebreak to a verdict at the live head only. A content-current verdict at a moved head is ranked by write recency alone, so the change can only ever let a FAIL win an ordering a PASS used to win — never the reverse.

**Rendered-visual verdicts are excluded.** `review-ui` attests deployed pixels, which are not a function of a diff; that namespace stays head-bound (#4808's class).

## Alternatives considered

- **A digest over the unified diff bytes.** Rejected as fail-open: invariant across a base move by construction, so it takes the first job and drops the second with nothing replacing it.
- **A digest over the merged tree.** Catches everything, including every unrelated main commit — which is the current over-broad rule wearing a new name, and would have removed none of the tax that opened the ticket.
- **Leaving it as-is and enforcing the #4477 ordering.** Genuinely cheaper and still correct advice: an approval solicited before a required branch update is spent on a head that must move. It reduces the tax without removing it, which is why this was `p2` and not `p1` — it is a complement to this ruling, not a substitute.
