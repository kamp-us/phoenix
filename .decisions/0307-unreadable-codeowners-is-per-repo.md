---
id: 0307
title: An unreadable CODEOWNERS follows the repo's own declaration, whose shipped default ships
status: retired
date: 2026-08-19
tags: [control-plane, fabrika, config, ship]
---

# 0307 — An unreadable CODEOWNERS follows the repo's own declaration, whose shipped default ships

> **Retired — this behaviour was reverted on
> [#5631](https://github.com/kamp-us/phoenix/issues/5631) and never shipped.** The founder ruled
> that the code comes back to ADR [0220](0220-cp-surface-declared-at-standup.md) as written, and the
> revert landed on the same epic that would have carried this record: `ship/boundary.ts` reads
> CODEOWNERS as two facts again, an unreadable file is exit `11` in every repo, and no config value
> waives it. The `unreadableCodeowners` key still resolves in `status settings` but nothing reads
> it. **Everything below this line describes a decision that was withdrawn before it ran** — it is
> kept as the record of what was tried and why it was pulled back, not as law. The live rule is
> 0220 §4 and ADR [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md) §4.

**What this decides:** when fabrika cannot read `.github/CODEOWNERS`, what happens next is a value
each repo writes in its own `.fabrika.jsonc`; a repo that writes nothing gets the value that ships
the pull request, and phoenix writes the strict one.

## Context

This record transcribes a ruling the founder already made. It does not open the question.

fabrika decides "is this change control plane?" from `.github/CODEOWNERS` at the pull request's base
ref ([the §CP classification model](../claude-plugins/fabrika/docs/control-plane-classification.md),
ADR [0053](0053-control-plane-boundary.md)). Until now every failed read of that file was exit `11`
in every repo — the caller refused and nothing shipped.

That is right for phoenix and wrong for an adopter. fabrika ships as an installed plugin into repos
that are not this one (ADR [0273](0273-fabrika-ships-as-an-installed-plugin.md)), and in a repo
where CODEOWNERS gates nothing, a transient GitHub read failure stranded every lane on a gate that
repo never asked for.

The founder ruled it on [#5603](https://github.com/kamp-us/phoenix/issues/5603): comment 28 —
*"ideally phoenix itself should be using the .fabrika.jsonc to rule whatever the fuck this means"* —
rejects a code fork between phoenix and adopters and makes the behaviour a config key, with comment
16's answer (ship) as the shipped default. Both comments carry `grill-ruled` stamps. The code landed
on [#6299](https://github.com/kamp-us/phoenix/issues/6299). The ruling was carried only by those
comments, which is why this file exists: a shipped default looser than the behaviour two live
records describe is exactly the change that needs one.

**Relation to ADR [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md) §4.**
That section describes §CP detection as *"resolved live from `origin/main` and fail-closed on an
unreadable boundary"*. After this decision, fail-closed on an unreadable boundary is what phoenix
declares rather than what fabrika does everywhere, so 0135 is amended in part. **Nothing else in
0135 moves**: approve-then-enqueue, the current-head binding of the approval, and the GitHub-level
`require_code_owner_review` enforcement are untouched, and phoenix's own behaviour at the gate is
identical to before.

**Relation to ADR [0092](0092-gates-fail-closed-on-zero-scope.md).** 0092's rule — every gate fails
closed when its enforcement scans zero scope — is untouched, and it is not what this decision is
about: an unreadable file is a failed read, not a scan that found nothing, and a boundary that reads
fine but bounds nobody still holds `unknown` and still fails closed. 0092's stated design bias,
*"default FAIL, pass on positive evidence of scope"*, is a different matter, and this decision does
cross it for an adopter repo that declares nothing. That crossing is the founder's, taken with the
strict value kept available and declared wherever the gate is real. The bias still governs
everywhere else, including this key's own failure mode.

## Decision

**What fabrika does with an unreadable `.github/CODEOWNERS` is declared per repo, by the
`unreadableCodeowners` key in `.fabrika.jsonc`, read at the same base ref as CODEOWNERS itself.**

The key has exactly two values.

| value | behaviour |
| --- | --- |
| `"refuse"` | exit `11` — the boundary is UNKNOWN and the caller refuses, which is what every repo did before this decision |
| `"ship"` | the change classifies `not-control-plane` and the pull request ships; the reason the read failed is printed |

**The shipped default is `"ship"`** — a repo that declares nothing is not stranded by a transient
read failure on a gate it never set up.

**Phoenix declares `"refuse"`** in [`.fabrika.jsonc`](../.fabrika.jsonc), because here CODEOWNERS
*is* the control-plane gate and a failed read shipping a §CP change unreviewed is the failure
[#4216](https://github.com/kamp-us/phoenix/issues/4216) exists to prevent.

**Binding constraints.**

- **The loose default is admissible only paired with the declaration.** Landing the default in a
  repo where CODEOWNERS is the gate, without that repo declaring `"refuse"`, is the fail-open. In
  phoenix the pairing is held by a machine: a unit test reads this repo's real `.fabrika.jsonc`
  through the shipped loader and reds if the declaration ever leaves or the file is deleted.
- **A config that could not be read waives nothing.** An unreadable `.fabrika.jsonc`, or a value off
  the two-word vocabulary, is exit `11` whatever the boundary said. A policy nobody read cannot
  waive a gate, so the key's own failure mode stays fail-closed.
- **Three reads of CODEOWNERS stay three facts.** Proven absent is `not-§CP` (the repo declares no
  control plane), present-and-parsed is classified with the `unknown` hold intact for a boundary
  that bounds nobody, and unreadable is this key. They do not fold into each other.
- **The waiver is never silent.** Where the policy ships an unreadable boundary, the verb prints the
  reason the read failed.
- **This decision does not widen who may approve, or what a §CP approval must be bound to.** Those
  are 0135's, and unmoved.

## Consequences

An adopting repo with no `.fabrika.jsonc` can now ship through a transient CODEOWNERS read failure
rather than deadlocking, which is the point. The cost is that fabrika's fail-closed-on-unreadable
guarantee is now a property a repo declares rather than a property of the tool, so an adopter whose
CODEOWNERS genuinely gates must write `"refuse"` — and the adopter guide and the §CP classification
doc both say so at the point an adopter reads them.

One fact now lives in several places that have to move together: the key module, phoenix's config
comment, [`.patterns/fabrika-config-key-groups.md`](../.patterns/fabrika-config-key-groups.md), the
`ship` skill's contract, the adopter guide, and this record. That is the price of serving different
readers; this file is the why, and the others point at it rather than re-deriving it.

## Records

no vocabulary impact
