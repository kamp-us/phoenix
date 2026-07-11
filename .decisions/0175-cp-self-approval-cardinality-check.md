---
id: 0175
title: "§CP self-approval gate is non-deterministic; make it a hard `gh api` team-cardinality check (branch team size 0-1-N), with a single-owner degenerate-case discharge policy that ship-it evaluates from org/team shape, not agent judgment (extends 0135)"
status: accepted
date: 2026-07-11
tags: [pipeline, ship-it, security, control-plane, governance, github]
---

# 0175 — Make the §CP self-approval gate deterministic: a hard team-cardinality check with an explicit single-owner discharge policy

> **Status: ACCEPTED** — ruled by umut on 2026-07-11 for [#2435](https://github.com/kamp-us/phoenix/issues/2435).
> The implementing ship-it §CP gate edit is a separate, gate-critical (§CP) unit tracked as a follow-up.

## Context

The §CP approval gate ([0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md),
amending [0053](0053-control-plane-boundary.md)) is the two-person control on the control plane:
`ship-it` enqueues a §CP PR only once a `@kamp-us/control-plane` team member has APPROVED it at the
current head. 0135 §1 models the team as **exactly two humans** (`usirin` + `cansirin`) and rests
the whole gate on one platform fact: *GitHub blocks self-approval*, so the author's own approval
never counts and **the other member** must approve
(0135 lines 46-56; the tradeoff restated at 0135 lines 112-118, 132: "a §CP change authored by
`usirin` needs `cansirin`'s approval, and vice versa"). That is the point of the gate — two humans
to change the machinery that performs every merge.

**The unspecified case: team cardinality ≠ 2.** 0135 never specifies what the gate does when the
control-plane team has **one present member** (or zero). In that degenerate shape the sole owner
*is* the control-plane team; GitHub still blocks their self-approval; and 0135's "a *different*
member must approve" rule can never be satisfied — so **every §CP PR is unmergeable-by-construction
(deadlock)**. The ship-it gate as written encodes exactly this: it collects current-head APPROVED
reviews, keeps those authored by a `control-plane` team member, and STOPs unless one is found
(`claude-plugins/kampus-pipeline/skills/ship-it/SKILL.md` §CP approval gate, the `CURRENT_APPROVERS`
→ `CP_OK` loop, lines 376-399). In a single-owner org that `CP_OK` can never be set, because the
only current-head approver possible is the author, and the author's approval never lands as an
APPROVED review at all.

**The observed symptom: non-determinism.** Because the degenerate case is *unspecified*, agents
resolved it by ad-hoc judgment, and the same conditions in one run produced opposite verdicts —
per [#2435](https://github.com/kamp-us/phoenix/issues/2435), single-owner org with no present
`@kamp-us/control-plane` member, §CP PR self-approved by the sole owner at head, all machine gates
green: `#2655` / `#2658` / `#217` merged (self-approval accepted as discharging §CP) while `#44` was
refused (parked at `awaiting control-plane approval`). A gate whose verdict depends on which agent
ran it is not a gate. The root blocker is an **unspecified policy**, not a nameable code bug:
`ship-it` cannot pick the discharge rule for the degenerate case — that is a decision, which this
ADR records so the check becomes deterministic.

This is a knowledge artifact (`.decisions/**`), not a gate-critical skill edit, so it is **not §CP
itself** and lands via the normal `review-doc` path. The *implementation* — editing the ship-it §CP
gate to run the cardinality introspection — is a distinct, blocked-on-this-decision unit
(#2435 triage note).

## Decision

Replace the agent judgment with a **hard, deterministic check keyed on
control-plane-team shape**, evaluated at gate time from org/team introspection via `gh api` REST
(never GraphQL — the org's Projects-classic integration breaks GraphQL, per 0135 lines 96-98). The
gate branches on the **cardinality of present, active, human `@kamp-us/control-plane` members**
(`N` = the count from `GET /orgs/{org}/teams/control-plane/members`, filtered to `active`
membership state, matching 0135's `active`-state membership resolution):

### The cardinality branch

- **`N ≥ 2` (0135's assumed multi-member model) — unchanged.** Self-approval does **not** discharge
  §CP. A current-head APPROVED review authored by a `@kamp-us/control-plane` member who is **not the
  PR author** is required. This is 0135's existing rule, now stated as the deterministic `N ≥ 2`
  branch: the two-person control holds.

- **`N == 1` (single-owner degenerate case) — a conscious self-approval at head discharges §CP.**
  When the sole present control-plane member *is* the PR author, the "different member must approve"
  rule is unsatisfiable-by-construction, and requiring it makes every §CP PR unmergeable (deadlock,
  since the sole owner *is* the team). In that shape a **deliberate self-approval signal by the sole
  owner, bound to the current head**, discharges the §CP gate. Because GitHub does not record a
  native self-approval, the discharge signal is the **marker-comment idiom already used elsewhere in
  the pipeline for the single-operator constraint** (the same self-approval-is-blocked reality that
  makes ship-it consume a marker comment rather than a native approval — 0135 lines 33-40; ship-it
  SKILL lines 397-399), authored by the sole owner and SHA-bound to the current head (`commit_id ==
  head`), never a stale-head signal.

- **`N == 0` (no present control-plane member) — STOP, fail closed.** No human control-plane member
  is present to discharge the boundary, so the gate does **not** enqueue. It STOPs at `awaiting
  control-plane approval` and reports that the team is empty — the security boundary must not be
  discharged with no accountable human, so the deadlock here is the *correct*, fail-closed outcome
  (a control-plane change with nobody to own it must not auto-ship). This is distinct from the
  `N == 1` deadlock, which is a construction artifact worth resolving; `N == 0` is a real absence.

### The deterministic check ship-it runs

At the §CP gate, before the approver check, resolve team cardinality and branch:

```bash
ORG="${REPO%%/*}"
# Present, active, human control-plane members (REST, never GraphQL — 0135)
MEMBERS="$(gh api --paginate "orgs/$ORG/teams/control-plane/members?per_page=100" --jq '.[].login')"
N="$(printf '%s\n' "$MEMBERS" | grep -c .)"
AUTHOR="$(gh api "repos/$REPO/pulls/$PR" --jq '.user.login')"
HEAD="$(gh api "repos/$REPO/pulls/$PR" --jq '.head.sha')"
case "$N" in
  0) echo "§CP: control-plane team empty → STOP (no human to discharge; fail closed)";;
  1) # sole owner IS the team: a current-head self-approval marker by that owner discharges
     echo "$MEMBERS" | grep -qx "$AUTHOR" \
       && echo "§CP single-owner: sole owner == author → a current-head self-approval marker discharges §CP" \
       || echo "§CP single-owner: sole member is not the author → require that member's current-head approval";;
  *) echo "§CP multi-member (N=$N): require a current-head APPROVED review by a DIFFERENT control-plane member (0135)";;
esac
```

The `N ≥ 2` branch then runs 0135's existing current-head team-approval resolution unchanged (the
`CURRENT_APPROVERS` → `CP_OK` loop, ship-it SKILL lines 376-392), additionally asserting the
approver `!= AUTHOR`. Every other machine gate is untouched: the SHA-bound gate verdict (0058),
CI-green (0061), the run-evidence bundle (0054), single-merge-authority (0048) — the cardinality
branch only decides *whether the §CP enqueue is unblocked*, never substitutes for a machine gate.

## Consequences

- **The gate becomes deterministic.** The §CP verdict is now a function of org/team shape + the
  current-head approval/marker state — reproducible across agents. The #2435 non-determinism
  (`#2655`/`#2658`/`#217` merged vs `#44` refused under identical conditions) cannot recur: the same
  inputs yield the same verdict.
- **The single-owner deadlock is resolved, deliberately and narrowly.** `N == 1` no longer wedges
  every §CP PR; the sole owner discharges via a conscious, SHA-bound self-approval marker — the
  minimum needed to make a single-owner repo operable, no broader.
- **The two-person control is preserved exactly where it exists.** For `N ≥ 2` the boundary is
  unchanged: a *different* member must approve at head. Adding a second control-plane member
  automatically re-tightens the gate to 0135's two-person control with no further ADR — the branch
  keys on live cardinality.
- **`N == 0` fails closed.** An empty control-plane team blocks §CP enqueue rather than opening a
  hole — the safe default when no accountable human is present.
- **Extends [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md), does not
  supersede it.** 0135's boundary definition, its `N == 2` two-person control, and its SHA-freshness
  rule are all preserved; this ADR only *specifies the cardinality branch 0135 left implicit* and
  makes the degenerate cases deterministic. 0135's body is not edited.
- **Implementation is a separate, blocked-on-this unit.** Editing the ship-it §CP gate to run the
  cardinality introspection is gate-critical (§CP) and lands via its own PR now that this ADR is
  accepted (#2435 triage note); this ADR is scoped to the policy.
- **Banned:** resolving §CP discharge by agent judgment; a self-approval discharging
  §CP when `N ≥ 2`; auto-enqueuing a §CP PR when `N == 0`; a stale-head self-approval marker
  discharging the single-owner case; resolving team membership over GraphQL.

## Vocabulary impact

No vocabulary impact — this ADR re-decides gate mechanics (a cardinality branch) over already-named
concepts (§CP, the control-plane team, SHA-bound approval); it coins and redefines no term.
