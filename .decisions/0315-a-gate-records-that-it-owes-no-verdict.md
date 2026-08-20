---
id: 0315
title: A gate records that it owes no verdict, rather than the class being narrowed to guess for it
status: accepted
date: 2026-08-20
tags: [fabrika, ship, review-ui, pipeline, wire-formats]
---

# 0315 — A gate records that it owes no verdict, rather than the class being narrowed to guess for it

**What this decides:** `ship gate` gains a fifth namespace state, `routed`, filled by a head-bound
`routed-elsewhere` record that `review-ui` emits with no capture evidence. The `ui` class stays the
simple path derivation it is. Founder ruling on
[#6376](https://github.com/kamp-us/phoenix/issues/6376), 2026-08-19:
[the comment](https://github.com/kamp-us/phoenix/issues/6376#issuecomment-5346296451).

## Context

Two rules in this repo disagreed, and neither could give.

`ship scope` raises the `ui` artifact class — and with it the required `review-ui` namespace — from
a path test in `packages/fabrika-cli/src/review/classes.ts`: `apps/web/src/` minus test files. A
path test cannot see whether anything renders differently, so a PR whose only `apps/web/src/**`
change is a docblock or a prose config note gets `class ui` and owes a `review-ui` verdict.

`review-ui` owes a verdict only when a rendered-visual surface changed, and its emit path is
*structurally* unable to produce one otherwise: `review-ui render` refuses zero `--surface`
operands, and `review-ui post` requires `--evidence` naming a capture set. That refusal is
deliberate — "rendered nothing, found nothing wrong" is meant to be unrepresentable (ADR 0092).

`ship gate` treats a missing namespace as blocking, and the required set is a floor raised from the
diff rather than a ceiling a session may lower (#3944, #5036). So the namespace was unfillable and
the block was permanent. It stranded PR #6326 — a repo-wide rename whose two flagged files are
prose only — and the same shape stranded #5738 before it. The only escapes were hand-posting a
marker, which is exactly how a false PASS ships, or rendering unrelated pages and passing the
captures off as evidence of a diff they have nothing to do with.

## Decision

**Candidate 1 of the two the report named.** `review-ui` gains a fourth verb, `review-ui route`,
which posts a `routed-elsewhere` record: the namespace it resolves, the head whose diff was read,
and a stated reason. `ship gate` resolves that namespace as `routed`, and `routed` satisfies the
conjunction beside `pass`.

Four fences make it a repair rather than a bypass.

**It is not a verdict, in the bytes.** `routed-elsewhere` is its own wire format under its own key,
carrying no polarity. `verdict-marker` reads a route as `Absent` and this reader is `Absent` on
every verdict marker, so no reading turns one into the other. A PASS says a gate looked and found
nothing wrong; a route says the gate's subject is not in the diff. Fold them and "I judged nothing"
ships as "I judged it and it passed", which is the exact failure the evidence requirement exists to
prevent — so `ship gate` carries `routed` as a state of its own and prints it, never as a quieter
`pass`.

**One namespace, and no other.** `ship gate` admits a route for `review-ui` alone. No other gate has
`review-ui`'s shape: `review-code` can PASS a one-line diff, `governance` can PASS a diff that
contradicts no ADR. Admitting the record anywhere else would turn a one-namespace repair into a
general "I decline this gate", which is merge authority no session holds. `ship floor` is untouched:
it asks `ship gate` for `governance` and requires `pass`, so the governance floor cannot be routed
around.

**Head-bound, never content-bound.** Any push voids the record and the new tree is attested afresh.
A route surviving a head move would be a claim about a diff nobody has read since.

**Attested, and checked like a verdict.** The record is authored, so the ADR 0055 write+ ACL binds
it exactly as it binds a marker, and the stated reason lands in the record's own bytes where a
reader can check it against the diff. `review-ui route` also refuses a PR whose diff raises no `ui`
class at all, re-using `isUiSurface` rather than a second predicate — a route resolving a namespace
nobody required records an answer to a question nobody asked.

**Rejected: candidate 2, narrowing the `ui` class** to paths whose diff touches a rendered artifact.
It is cheaper and it relocates the defect rather than fixing it: no path test can decide whether
pixels moved, so the narrowed rule is wrong on the next shape nobody anticipated, and this time it
would be wrong in the permissive direction — a real UI change classified out of review. The
derivation stays honest and dumb; the escape is explicit and recorded.

## Consequences

- A prose-only `apps/web/src/**` PR reaches a terminal ship state through the machine, with no
  hand-posted marker and no fabricated render evidence.
- Judging whether a diff renders anything stays the skill's, formed over `review diff`'s
  refusal-guarded bytes. No verb decides it, and none may be added that does.
- `ship gate`'s state vocabulary is five wide. A consumer reading its rows must handle `routed`;
  reading it as `pass` loses the distinction the whole decision rests on, and reading it as a block
  restores #6376.
- A route is one comment, upserted, so a PR carries at most one claim per namespace about this
  question.
- `review-ui`'s `ROUTED-ELSEWHERE` terminal now lands a record instead of emitting nothing. The
  namespace it leaves behind is resolved rather than empty, which is what makes the terminal
  reportable at all.
