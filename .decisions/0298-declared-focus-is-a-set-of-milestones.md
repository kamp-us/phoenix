---
id: 0298
title: The declared focus is a set of milestones, not one
status: superseded by [0304](0304-campaign-active-is-the-dispatch-permission.md)
date: 2026-08-18
tags: [fabrika, pipeline, roadmap, adoption]
---

# 0298 — The declared focus is a set of milestones, not one

**What this decides:** `ROADMAP.md`'s `## Focus` table carries N rows, and the fence admits an issue
homed in **any** of them. Exclusive focus — one milestone, everything else off the table — is
retired as a premise. ADR [0245](0245-campaign-scope-fence-binds-both-seams.md)'s other rule stands
untouched: both `build` seams still compute admission from one shared predicate.

## Context

0245 built the scope fence on phoenix's own shape: one founder, one campaign at a time. The
cardinality rode along as a premise nobody separated from the fence itself, and it hardened into
three places at once — `readFocus` refused a second data row as malformed, `scopeAxisOf` tested
scalar equality against the one milestone, and `pipeline-cli`'s roadmap-guard invariant I6 red the
CI job on `focus.length > 1`.

Milestone 47 is adoption: running fabrika outside phoenix. The first real consumer,
`binclusive/monorepo`, has four developers and legitimately runs several streams at once. Under a
one-row fence most of that board refuses at claim, and every second lane needs a driver override —
which is precisely the fail-open pressure the fence exists to prevent. A fence people route around
is not a fence.

It had already bitten inside phoenix, a one-founder repo, twice in one night: the maiden epic's
children ([#5969](https://github.com/kamp-us/phoenix/issues/5969)) and
[#5768](https://github.com/kamp-us/phoenix/issues/5768) both needed rehoming before a builder could
claim them.

Founder ruling, 2026-08-18, on [#6005](https://github.com/kamp-us/phoenix/issues/6005): *"is focus a
hard requirement btw? if so we gotta change that, because currently binclusive/monorepo works with 4
devs."*

## Decision

**The declared focus is a set. `## Focus` carries N rows of the existing `Milestone | Declared`
grammar, one per milestone, and an issue is admitted on the scope axis when its home is a member of
that set.**

**Same grammar, more rows.** The set is not a second declaration surface. It is the table that
already exists, already parses and already has a guard — nothing moves to `.fabrika.jsonc` (#5631)
and no new file is read.

**A one-element set is today's behaviour, exactly.** Phoenix keeps its single row and loses nothing;
the scope line still reads `focus: milestone #46, declared 2026-08-18`.

**Malformed still binds the whole declaration.** One unreadable row makes the entire focus
`Malformed` (`4`) rather than degrading to the rows that parsed. A partial read reported as the focus
is a fence quietly narrower than what was written, which is the well-formed-and-always-wrong shape
0245's `Malformed` case exists to refuse.

**`roadmap-guard` I6 keeps the honesty check and drops the count.** Every row must pin a `#N` that
resolves, is open, and is claimed by an `active` arc or campaign row. Row count is no longer an
invariant; zero rows stays the well-formed default.

**Both halves land together.** fabrika reading N rows while I6 reds the second one would leave a repo
unable to declare what fabrika would accept. There is no half-landing of this.

**Binding constraints.**
- Scope admission stays computed in one place and consumed at both `build` seams — ADR 0245's
  both-seams-one-predicate rule is untouched, and no seam re-reads the declaration for itself.
- `None` stays the well-formed off switch; absence and emptiness still admit everything.
- `Malformed` is still never read as "no focus", and now never as "the rows I could read" either.
- The standing-lane exemption of ADR [0208](0208-standing-lane-exemption-from-full-homing.md) is untouched: a
  lane-labelled issue is admitted whatever the set says.
- Every message that names the fence's state names the **whole set** — the scope line, the machine
  `focus` field, and both refusals — so an operator never reads a narrower fence than the one running.

**Banned.**
- A second declaration surface for the focus beside the `## Focus` table.
- Degrading a malformed declaration to its readable rows.
- A count invariant on `## Focus`, in fabrika or in `roadmap-guard`.

## Consequences

**The fence gets weaker per repo, and that is the point.** A repo declaring four milestones fences
less than one declaring one. The fence's job is to keep lanes off work nobody declared, not to
enforce a working style; a repo that wants exclusivity declares one row and gets exactly the old
behaviour.

**A stale row is now cheaper to leave lying around.** Under one row, a wrong focus stopped everything
and was noticed immediately. Under a set, an extra row admits work quietly. I6's per-row honesty
check is what carries this: a row over a closed or unclaimed milestone still reds CI.

**0245's exclusivity language is superseded, its structure is not.** Read 0245 for why the refusal
binds at both seams and why one predicate answers it; read this record for how many milestones that
predicate admits.

## Records

Fixes [#6005](https://github.com/kamp-us/phoenix/issues/6005). Supersedes the exclusive-focus premise
of ADR [0245](0245-campaign-scope-fence-binds-both-seams.md). 0245 carries the reciprocal
`amended-in-part by [0298]` status-line pointer, written by `fabrika adr amend-in-part`; its body is
untouched, because an accepted record's decision text is immutable.

Vocabulary impact: **declared focus** changes from "the single milestone in exclusive focus" to "the
set of milestones in declared focus"; the entry in [`.glossary/TERMS.md`](../.glossary/TERMS.md) moves
with this record, as does the `## Focus` grammar prose in [`ROADMAP.md`](../ROADMAP.md).
