---
id: 0148
title: künye — what a ban does to the released çaylak→yazar vouch/kefil graph (revoke outstanding vouches, no cascade demotion, moderator-visible provenance, social-not-mechanical sponsor liability)
status: accepted
date: 2026-07-04
tags: [kunye, kefil, vouch, moderation, tandem, karma]
---

# 0148 — künye ban vouch/kefil-graph semantics

## Context

The earned-authorship rite is a graph: a **yazar** vouches (**kefil**) for a
**çaylak**, and that vouch — recorded in the `VouchLedger` (`authorship_vouch`
table) — is one of the two halves the order-independent **tandem** resolver
requires to flip the çaylak to **yazar** (the other half is the net-karma bar,
`VOUCH_PROMOTION_KARMA_BAR = 15`). The vouch rite is **released** (the invite-tree
scope is dead — no invite-code system is built; the vouch/kefil rite is what
satisfies the invite-only thesis while registration stays open). So the graph is
live production state, and a question that was theoretical is now operational:
**when a yazar is banned, what happens to the vouches they gave?**

Issue [#144](https://github.com/kamp-us/phoenix/issues/144) is the decision that
owns this. A banned yazar sits at the root of a kefil cluster with three distinct
kinds of edge to reason about, each needing a settled rule:

1. **Outstanding pre-promotion vouches** — vouches the banned yazar gave to
   çaylaks who have *not yet* been promoted (the vouch is active-by-existence in
   the `VouchLedger`, the çaylak is still `çaylak`, tandem has not yet fired
   because the karma half is unmet or freshly met).
2. **Already-promoted vouchees** — çaylaks the banned yazar vouched for who have
   *already* crossed tandem and are now `yazar`.
3. **Kefil provenance** — what a moderator can see of the graph, so a cluster of
   promotions rooted at one now-banned sponsor is inspectable.
4. **Sponsor liability** — whether a ban mechanically penalizes the sponsor's
   *other* standing (an automatic cascade on their remaining graph), or whether
   liability is social (visible provenance + human moderator judgment).

This is **blocking input to moderator-UI planning** — ban/demotion actions surface
in the mod-UI, and their graph semantics must be settled before those controls are
designed.

## Decision

This is an **evaluate-then-adopt** decision: the founder-leaning proposal (#144's
body) was evaluated explicitly and **adopted as-is with one clarification**. The
2026-07-04 ruling adopted the four rules below unchanged; the 2026-07-16 ruling
re-affirmed them and added the single clarification recorded as rule 5. Five rules
govern a ban's effect on the released vouch/kefil graph:

1. **A banned yazar's outstanding pre-promotion vouches → revoked; each affected
   çaylak's tandem check re-runs.** A vouch given by a now-banned yazar is no
   longer a valid promotion input, so it is revoked from the active set. Because
   the `VouchLedger` is active-by-existence (a vouch is active iff its row exists
   and the candidate is still çaylak — there is no `withdrawn` column), revocation
   frees the slot, and the affected çaylak's **tandem** resolver re-runs against
   the remaining graph. A çaylak who still holds another active vouch and meets
   the karma bar still promotes; one who relied solely on the banned yazar's vouch
   does not.

2. **Already-promoted vouchees keep yazar — no cascade demotion.** A çaylak who
   already crossed tandem and became yazar is *not* demoted when their sponsor is
   banned. Promotion is a completed act; the tandem flip is not retroactively
   unwound by a later ban of the voucher. The ban does not cascade down the graph.

3. **Kefil provenance stays visible to moderators.** The vouch graph — who vouched
   for whom, and the clusters that form around a sponsor — remains inspectable by
   moderators. A cluster of promotions rooted at a now-banned yazar is *legible*,
   so a moderator can review it by hand.

4. **Sponsor liability is social, not mechanical, in v1.** A ban carries **no
   automatic penalty on the sponsor's other standing** and no mechanical cascade
   across their remaining graph. Liability is discharged by **visible provenance +
   human moderator judgment**: the mod sees the cluster (rule 3) and acts case by
   case, rather than the system auto-penalizing every account the sponsor touched.

5. **A çaylak who drops below the promotion threshold after the rule-1 tandem
   re-run reverts to çaylak — re-vouchable, no penalty, not limbo** (clarification,
   2026-07-16 ruling). Revoking the banned yazar's vouch (rule 1) can leave a
   not-yet-promoted çaylak short of the tandem bar. That çaylak is simply a çaylak
   again: they may receive a fresh vouch from any other yazar and re-run tandem
   normally, they carry **no** mark or penalty from the revoked vouch, and they are
   **not** placed in a distinct suspended/quarantined state. This is the
   already-implied behavior of an active-by-existence `VouchLedger` (a revoked
   vouch is indistinguishable from one never given) stated explicitly, so the
   mod-UI never invents a limbo status for these çaylaks.

## Consequences

- **Feeds mod-UI ban controls before they are designed.** These five rules are the
  settled graph semantics that
  [#1665](https://github.com/kamp-us/phoenix/issues/1665) (moderator-UI planning)
  and [#970](https://github.com/kamp-us/phoenix/issues/970) (ban / unban a user
  with enforced session refusal + audit) build the ban-action surface on. The
  ban control must, on ban of a yazar: revoke that yazar's outstanding
  pre-promotion vouches, re-run tandem for each affected çaylak, leave promoted
  vouchees untouched, and expose the kefil provenance cluster to the acting
  moderator.

- **The re-run is exactly the existing tandem path — no new demotion mechanism.**
  Rule 1 reuses the order-independent `resolveTandem` that already fires on
  vouch-slot changes: revoking a vouch is a slot change, so tandem re-evaluates
  with no bespoke logic. There is no "un-promote" code path introduced anywhere —
  rule 2 makes cascade demotion a non-goal, so the only state that moves is a
  not-yet-promoted çaylak whose last valid vouch was revoked (they simply remain
  çaylak, the same as if the vouch had been withdrawn).

- **Social-not-mechanical liability is a deliberate v1 choice — the why.** A
  mechanical sponsor penalty (auto-demote every account a banned yazar vouched for,
  or auto-dock the sponsor's other standing) would be a blunt instrument that
  punishes good-faith promoted authors for their sponsor's later misconduct and
  invites collateral damage from a single bad ban. v1 keeps a human in the loop:
  the graph is made *legible* (rule 3) and a moderator decides, rather than the
  system cascading automatically. Mechanical liability can be revisited if the
  social model proves insufficient at scale; v1 does not pre-build it.

- **No cascade demotion bounds the blast radius of a ban.** Rule 2 means a ban is a
  local act at the vouch-slot level (outstanding vouches only), not a graph-wide
  event — which keeps ban semantics predictable and prevents a ban from silently
  stripping authorship from established, blameless authors.
