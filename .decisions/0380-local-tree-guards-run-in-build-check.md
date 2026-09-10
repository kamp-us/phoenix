---
id: 0380
title: build check runs every local-tree guard by name, never a repo declaration and never a blind loop
status: accepted
date: 2026-09-10
tags: [fabrika, cli, pipeline, gates, build]
---

# 0380 — build check runs every local-tree guard by name, never a repo declaration and never a blind loop

**What this decides:** a builder's local `fabrika build check` now runs the shipped guards that only
need the checked-out tree, and names each one in its answer, so a guard that reds in CI reds on the
builder's machine first.

## Context

`fabrika build check` runs exactly the argv entries the repo declares under `.fabrika.jsonc`'s
`codeValidators` — here `pnpm typecheck:affected` and `pnpm lint:worktree`. It never runs a
`fabrika guard <name> check`. Its green therefore means *the declared validators passed*, and a
builder reads it as *this tree is CI-clean*, which is a different sentence.

That gap costs review rounds now, and each one is a reviewer reproducing a guard instead of judging
the change:

- [PR #8460](https://github.com/kamp-us/phoenix/pull/8460): a new pnpm patch with no `@patch-pin`
  marker. `build check --surface code` green, `guard patch-guard check` red at the same tip
  ([the failing round](https://github.com/kamp-us/phoenix/pull/8460#issuecomment-5566307906), the
  [one-line repair](https://github.com/kamp-us/phoenix/pull/8460#issuecomment-5566370668)).
- [#8821](https://github.com/kamp-us/phoenix/issues/8821)'s last repair round, and
  [#6165](https://github.com/kamp-us/phoenix/issues/6165) / PR
  [#8960](https://github.com/kamp-us/phoenix/pull/8960) round 1: `portability-guard`, both times
  under a diff whose markdown never reached the `code` surface at all.

The ruling on [#8461](https://github.com/kamp-us/phoenix/issues/8461#issuecomment-5616628978) is the
driver's under [#8807](https://github.com/kamp-us/phoenix/issues/8807) R4.1 — engine health is the
driver's seat, the founder rules product (ADR
[0376](0376-driver-seat-for-non-product-parks.md)) — and this record transcribes it.

Two options were on the table and both were refused. **A blind loop over the whole `guard` registry**
breaks on its own membership: `unresolved-threads-guard` needs a PR number, `homing-guard` and
`pitch-guard` read the live board, `leak-guard`'s leaf is `scan` and `decisions-index`'s is
`validate`, not `check`. **A per-repo declaration in `codeValidators`** makes each consumer repo re-list the
guards fabrika already ships to it, and that duplication drifts from the CI workflows — drift is the
exact failure this record closes, so a fix that manufactures more of it is no fix.

## Decision

**Membership in the local-tree set is a property each guard declares, and `build check` runs every
member on every surface and reports each by name.**

- **A local-tree guard is argument-free, reads only the checked-out tree, and needs no PR number, no
  board read and no auth.** The predicate is declared per guard in
  [`packages/fabrika-cli/src/guard/command.ts`](../packages/fabrika-cli/src/guard/command.ts), beside
  the row that registers it, so adding a guard is where its membership is answered. The ruling names
  the expected members — `portability-guard`, `patch-guard`, `catalog-guard`, `readme-guard`,
  `fanout-guard`, `i18n-guard`, `decisions-index` — and the expected non-members —
  `unresolved-threads-guard`, `homing-guard`, `pitch-guard`. The other twelve registered guards are
  classified by the predicate, not by this list.
- **Every surface runs them, not `code` alone.** `portability-guard` reads shipped markdown, so a
  prose-only diff is exactly the diff that has been reaching review red. `--surface` stays an anchor
  over the repo's declared validators; the local-tree set is not anchored by it.
- **Each member is named in the answer.** A red is red, and the failing guard is named. A guard that
  refused — zero scope (exit 7) or an UNKNOWN read (exit 11) — is reported as
  `skipped: <name> (<reason>)` and is never folded into the green. A skip is a disclosure, not a
  pass: the builder reads it as *CI will answer this one*.
- **`.fabrika.jsonc`'s `codeValidators` stays what it is** — the repo's own extra commands. A repo
  never re-declares fabrika's shipped guards to get them run.
- **Nothing about CI or about any guard's own refusal semantics changes.** The workflow jobs still
  own the verdict, and `build check` still only predicts it.

**Binding constraints.**

- No guard needing a PR number, a board read or a network credential joins the local-tree set. The
  set's whole warrant is that a builder can run it offline against the tree in front of them.
- A guard's exit 7 or exit 11 is never translated to a pass anywhere on this path. ADR
  [0092](0092-gates-fail-closed-on-zero-scope.md) binds the CI gate and is untouched: this record
  adds a local predictor and gives it no authority to answer for one.
- Membership lives beside the guard's registration and nowhere else. A second list — in a config
  file, a workflow, or a skill — is the drift this record exists to prevent.

## Consequences

`patch-guard`'s missed `@patch-pin` on PR #8460 is the checkable outcome: under this contract that
same tree fails `build check` before the push, with `patch-guard` named on the red line, and the
review round it cost never happens. The same holds for the two `portability-guard` rounds, which
only a per-surface run reaches.

`build check` gets slower — a dozen tree walks on top of typecheck and lint — and the cost lands on
every lane, including the ones that would never have tripped a guard. That is the trade the ruling
takes: a walk of the tree is cheaper than a review round.

A consumer repo that installs fabrika inherits the guards on its local check path without declaring
anything, so a guard that is wrong for that repo is now wrong on every build there rather than only
in CI. The remedy is the guard's own scoping, which is where it already lives.

## Records

The bounded follow-on is the `build check` change itself and nothing more: declare the predicate on
each registered guard, run the members from
[`packages/fabrika-cli/src/build/check-verb.ts`](../packages/fabrika-cli/src/build/check-verb.ts) on
every surface, and add the `skipped:` line to the answer's shape. It is filed as
[#8973](https://github.com/kamp-us/phoenix/issues/8973). No universal guard loop, and no change to
any guard's exit codes.

Coins **local-tree guard**, defined in [`.glossary/LANGUAGE.md`](../.glossary/LANGUAGE.md) in this
pull request.

Sources: the ruling at
[#8461, comment 5616628978](https://github.com/kamp-us/phoenix/issues/8461#issuecomment-5616628978);
ADRs [0092](0092-gates-fail-closed-on-zero-scope.md) and
[0376](0376-driver-seat-for-non-product-parks.md);
[`packages/fabrika-cli/src/guard/command.ts`](../packages/fabrika-cli/src/guard/command.ts),
[`packages/fabrika-cli/src/guard/patch-verb.ts`](../packages/fabrika-cli/src/guard/patch-verb.ts),
[`packages/fabrika-cli/src/build/check-verb.ts`](../packages/fabrika-cli/src/build/check-verb.ts).
