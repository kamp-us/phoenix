---
id: 0055
title: ship-it Sources Reviewer Authorization from GitHub's ACL, Not a Checked-In Allowlist
status: accepted
date: 2026-06-14
tags: [pipeline, skills, ship-it, review-code, review-doc, security, agents]
---

# 0055 — ship-it Sources Reviewer Authorization from GitHub's ACL, Not a Checked-In Allowlist

## Context

Supersedes [0051](0051-author-bind-pass-marker.md). 0051 fixed the right problem — a
`review-code`/`review-doc` PASS marker is just a PR comment, so `ship-it` must check *who*
authored it before honoring it — but it rooted that check in the wrong place. The authorized
identity was an `AUTHORIZED_REVIEWERS='["usirin"]'` JSON literal living **in skill prose**
(`.claude/skills/ship-it/SKILL.md`). A checked-in constant is *instructions, not
enforcement*: it is editable, in a branch or a local copy, by the same actor it is meant to
constrain. Anyone with repo access can add their own login to the list and then self-author a
`PASS` marker; a `ship-it` run pointed at that skill copy would honor it. The allowlist
asserts authorization without proving anything about identity or permission — exactly the
self-grant 0051's author-binding was supposed to prevent.

The exposure is *contained* today, not active: ADR [0053](0053-control-plane-boundary.md)
makes `.claude/**` blocking and human-merge-only, so a malicious allowlist edit cannot reach
`main` autonomously. But containment is not soundness — authorization should come from a
source the PR author cannot widen via a file in their own diff.

There is also a concrete operational cost. `/ship-it 178` (a verified `.decisions/` PR)
refused with `unverified (no review-doc PASS)` because the only `review-doc: PASS` marker was
authored by `cansirin`, while the constant held only `usirin` — a legitimately-authorized
operator blocked by a hardcoded identity (#229).

The authoritative answer to "is this identity allowed to sign a merge here" already exists
outside the repo and is not editable by a PR author: **GitHub's own ACL**. The repo
collaborator-permission endpoint (`repos/kamp-us/phoenix/collaborators/<login>/permission`)
returns that identity's *effective* permission on this repo (`admin | maintain | write |
triage | read`) — and effective permission already folds in org-team grants, so it is both
more precise than org membership *and* a superset of it.

## Decision

`ship-it` **derives reviewer authorization from GitHub's repo ACL at merge time** and drops
the `AUTHORIZED_REVIEWERS` constant entirely. 0051's author-bind *principle* stands; only its
*trust source* changes (checked-in list → runtime ACL lookup).

1. **Trust source — repo collaborator permission.** For each candidate verdict marker,
   `ship-it` resolves the comment author's permission with
   `gh api repos/kamp-us/phoenix/collaborators/<author>/permission --jq .permission`. This is
   repo-scoped and reflects effective permission (direct collaborator *or* org-team grant), so
   it is preferred over org membership (`orgs/kamp-us/members/<login>`), which is coarser and
   says nothing about repo capability.

2. **Threshold — `write` floor.** An author authorizes a marker iff their permission is
   `write`, `maintain`, or `admin`. `triage` and `read` do not. The floor is "can this
   identity actually land code on this repo," which is exactly the population entitled to sign
   a merge verdict.

3. **`AUTHORIZED_REVIEWERS` is removed.** There is no checked-in allowlist of verdict
   identities. The ACL is the single source of truth for "whose PASS counts." A future
   dedicated review-bot earns standing by being a repo collaborator with `write+`, not by
   being named in a file.

4. **Native approving reviews remain canonical and need no lookup.** An `event=APPROVE`
   review is author-attributed and unforgeable by a non-reviewer (0051 §3); GitHub binds its
   author, so the ACL check applies only to the *marker-comment* path. The marker stays the
   load-bearing fallback for the operator's own PR (org branch rules block self-`APPROVE`) —
   now author-verified against the ACL instead of the constant.

5. **Fail closed.** If the permission lookup errors, returns `null`, or returns `triage`/
   `read`, that marker is treated as if it did not exist — not a verdict, not even a FAIL —
   exactly as 0051 treated an off-allowlist marker. If no authorized verdict remains in
   either form, `ship-it` reports `unverified (no … PASS)` and refuses. A forged or
   unauthorized PASS therefore lands in *refuse-and-report*, never in *merge*.

6. **Solo-operator path preserved.** `usirin` holds `admin`, so their own marker passes under
   the new source; `cansirin` (also `admin`) now passes too, resolving #229 without a
   re-decision. The single-merge-authority premise of ADR [0048](0048-ship-it-merge-actor.md)
   is unchanged — the set of authorized signers is now "repo writers" rather than "a literal,"
   which is the correct, self-maintaining generalization.

### Why ACL over a kept-but-overlaid allowlist

Keeping the constant as an "additive bot-overlay" was considered and rejected: it leaves a
self-modifiable identity surface in the diff (the exact spoofable seam this ADR closes), to
buy a future bot that the ACL path already serves the moment the bot is a collaborator. One
trust root, externally enforced, beats a primary check plus a writable side-channel.

## Consequences

- **Enforced, not asserted:** "whose PASS counts" is now an external, author-unwidenable fact
  (GitHub ACL). A PR author cannot grant themselves verdict authority via a file in their own
  branch — the central soundness gap in 0051's mechanism is closed.
- **Self-maintaining trust set:** any `write+` collaborator's marker counts with no skill
  edit; onboarding a second operator (`cansirin`) or a review-bot needs a GitHub permission
  grant, not a control-plane PR. Unblocks autonomous shipping for non-`usirin` operators.
- **New cost / dependency:** Step 2 marker resolution now makes one `gh api …/permission` call
  per candidate marker author, and depends on that endpoint being reachable. Unreachable ⇒
  fail closed ⇒ refuse — the safe direction, but a transient GitHub/API outage can turn a real
  PASS into a temporary `unverified` (re-run resolves it).
- **Banned:** honoring a marker without resolving its author's live repo permission; rooting
  verdict authority in any checked-in list; using org membership in place of repo collaborator
  permission; treating a `triage`/`read`/lookup-failed author as a verdict.
- **Scope — every consumer migrates in this change.** `ship-it`'s Step-2 resolution **and**
  `write-code`'s FAIL-scan/repair gate move to this ACL source in the same PR (closing #241,
  which also fixed the `gh api --argjson` defect — `--argjson` is a `jq` flag, not a `gh api`
  one, so the author gate is now run via standalone `jq … <<<"$comments"`). The
  `review-code`/`review-doc` gates needed no change: they emit and consume their *own* verdict,
  never resolving an other-authored marker against the allowlist, so there was nothing to
  migrate. The suite therefore agrees on "whose verdict counts" — any `write+` repo
  collaborator — across all gates with no transitional split.
- **Relationship:** supersedes [0051](0051-author-bind-pass-marker.md) (keeps its author-bind
  principle, replaces its allowlist mechanism); extends [0048](0048-ship-it-merge-actor.md)
  (refines *which* markers the single merge authority consumes). As a `.claude` control-plane
  change, this ADR and its `ship-it` edit are **human-merged** per ADR
  [0053](0053-control-plane-boundary.md); the pipeline does not self-merge changes to its own
  merge authority.
