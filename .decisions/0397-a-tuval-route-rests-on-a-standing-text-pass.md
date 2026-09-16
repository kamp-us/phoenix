---
id: 0397
title: A routed-elsewhere record rests on the text review it asserts
status: accepted
date: 2026-09-16
tags: [fabrika, review-ui, tuval, pipeline, governance]
---

# 0397 — A routed-elsewhere record rests on the text review it asserts

**What this decides:** the `review-code` verdict is a precondition of a `review-ui route`, not
commentary on it. `review-ui route` reads the verdict in force at `--sha` and refuses on a standing
FAIL; under the interim Tuval exception, where the route rests on a hand-verification, it refuses an
absent verdict too. Founder ruling on
[#9196](https://github.com/kamp-us/phoenix/issues/9196), 2026-09-15:
[the ruling comment](https://github.com/kamp-us/phoenix/issues/9196#issuecomment-5688739893),
recorded by the driver under the standing delegation of founder ruling #8807 R4.1.

## Context

The 2026-09-06 interim exception on [#7306](https://github.com/kamp-us/phoenix/issues/7306) lets a
Tuval PR resolve the `review-ui` namespace with a `routed-elsewhere` record instead of a rendered
verdict, and prescribes the clause that record carries, verbatim: "Tuval surface; no admissible
renderer until #7306 lands (founder ruling 2026-09-06). Text review PASS + builder hand-verification
stand in."

That clause asserts two things, and until now the verb checked neither.
[0391](0391-hand-verification-binds-ui-content.md) mechanized the second half: the
hand-verification's currency became `--verified-at`, landed on
[#9178](https://github.com/kamp-us/phoenix/issues/9178). The first half stayed written text.
`runRoute` in [`route-verb.ts`](../packages/fabrika-cli/src/review-ui/route-verb.ts) read the PR, the
live head, the `ui` class and the `--verified-at` range, and no verdict marker at all — so it would
post the clause at a head where the text gate stood FAIL, and exit 0.

The exception's own text is ambiguous about whether that PASS is required. The bullet after the
clause names exactly one thing as required — the builder's hand-verification — while the clause
asserts the conjunction, and the verb resolved the ambiguity permissively.

The pipeline has read it as a conjunction every time it was used: across #7306's sunset list of
80-plus entries no route was posted over a standing text FAIL, and on
[#8878](https://github.com/kamp-us/phoenix/pull/8878),
[#8804](https://github.com/kamp-us/phoenix/pull/8804) and
[#8802](https://github.com/kamp-us/phoenix/pull/8802) the text gate FAILed, the builder repaired, and
the route landed only at the subsequent PASS head. The gap surfaced on
[#9193](https://github.com/kamp-us/phoenix/pull/9193), where every mechanical precondition held at
the head, `review-code` stood FAIL at that exact head, and the gate ended CANT-SEE rather than post
a clause it could not defend.

The failure is 0391's quiet kind. The `routed-elsewhere` format carries no polarity and no attached
captures, so a record resting on a text PASS and one resting on a standing FAIL read identically, and
`ship gate` resolves both as `routed`. Nothing wrong merges — `ship` gates on `review-code`
independently — so what it costs is a false statement on the permanent record and on the sunset list
the first real Tuval UI review is meant to sweep against.

## Decision

**The text review the clause asserts is read by the verb, at the head the record binds.**

1. **A standing FAIL refuses the route.** The `review-code` verdict in force at `--sha` is resolved
   before anything is composed or posted, and a FAIL is exit `20` with the comment named. The route
   returns when the text gate passes on a head; nothing about the record changes in the meantime.
2. **Absence refuses exactly where the record claims a PASS.** A route carrying `--verified-at`
   stands in for the render under the #7306 exception, whose clause names both halves, so no text
   verdict binding `--sha` is the same `20`. A route with no hand-verification — a prose-only diff
   under a declared `uiSurfaces` prefix — asserts nothing about the text lane, so an absent verdict
   is stated on stderr and in the answer's `textReview` field rather than refused. This is the
   narrow arm of the ruling's direction: it makes the clause's assertion unpostable without its
   evidence, without ordering the two gates on every PR that has no such clause to make.
3. **The reader is `review verdicts`', and the ordering `ship gate`'s.** The claims are the
   `verdict-marker` first line and the §CP advisory carrier, ordered by `inForce` and judged current
   by `bindToContent`
   ([`text-verdict.ts`](../packages/fabrika-cli/src/review-ui/text-verdict.ts)). A condition each
   reader derives for itself is a condition each reader derives differently — 0391 §3's rule, applied
   to the other half of the same clause. A verdict the head has moved past is not in force, so a
   content-bound PASS that survives a rebase survives here too.
4. **GitHub's native review fold stays out.** `ship gate` folds an `APPROVED` or `CHANGES_REQUESTED`
   review into `review-code` because it is the merge authority. This verb judges only whether its own
   clause states something true, and the fold costs a second API surface for a carrier the text gate
   does not emit. The merge gate still reads it.
5. **The exception's text carries the condition.** It lands on #7306 as a dated amendment below the
   2026-09-06 ruling, never as an edit to it, so the sunset list stays readable against the text each
   entry was posted under — 0391 §5's rule, unchanged. Landed 2026-09-16:
   [the amendment comment](https://github.com/kamp-us/phoenix/issues/7306#issuecomment-5701952969),
   appended to the issue body in the same shape, stating both halves of the clause as required.

**Rejected: dropping the assertion from the clause instead.** It is the cheapest change and it
weakens what the sunset sweep can rely on: the first real Tuval UI review reads those entries back,
and an entry that claims nothing about the text lane tells it nothing. The founder was asked whether
a ui record may stand over a failed text review and answered no, so the clause stays and the verb
earns it.

**Rejected: refusing an absent verdict on every route.** It orders the two gates on PRs whose record
makes no claim about the text lane at all, and a review-ui lane that runs before the text one parks
on a fact about sequencing rather than about the PR.

**Sunset.** This decision lives exactly as long as the exception it conditions, as 0391 does. When
#7306 lands a trusted evidence path, the clause goes and this record is retired with it.

## Consequences

- A Tuval route over a standing text FAIL is refused at `20` rather than posted, and the reviewer's
  move is the one the pipeline already made by hand: let the text lane repair, route at the passing
  head.
- A Tuval route now needs the text verdict landed first. The reviewer reads what stands with
  `fabrika review verdicts <pr>` instead of deriving it from a comment scan.
- A prose-only route is unchanged in its outcome and louder in its answer: `textReview` says whether
  a text verdict backed it, so the sunset sweep can tell the two kinds of entry apart.
- A text verdict carried only by a GitHub native review does not clear the route. The refusal names
  the reader, so a lane in that shape sees why.
- #7306's sunset list gains the same fact per entry as 0391 gave it: which text verdict the record
  rested on, beside the hand-verification's head.

## Records

no vocabulary impact
