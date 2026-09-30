---
id: 0438
title: A repair round replaces the deviation disclosure in place, never appends a round-tagged log
status: accepted
date: 2026-09-30
tags: [pipeline, build, review, wire-format]
---

# 0438 — A repair round replaces the deviation disclosure in place, never appends a round-tagged log

**What this decides:** when a repair round rewrites a `## Deviations` section, the new section
replaces the old one. Nobody keeps a per-round history of it. This holds for a PR body and for an
epic child's `build-deviations` comment. ADR 0216 §4 ("Repair appends, never replaces") is retired.

Founder ruling on [#6847](https://github.com/kamp-us/phoenix/issues/6847), 2026-09-02:
<https://github.com/kamp-us/phoenix/issues/6847#issuecomment-5519865677>. The answer was "no" to
carrying earlier rounds forward. The ruling's lens: cut process toil, pick the cheapest option, and
add no new gate or token unless a failure actually recurs.

## Context

ADR [0216](0216-deviation-disclosure-is-a-pr-body-obligation.md) made deviation disclosure a
required PR-body section. Its §4 said a repair round must append to that section as a round-tagged
running log, and never rewrite it to the latest round's truth. 0216 is still `proposed`. It names
retired v1 surfaces (`write-code`, `review-doc`, `review-skill`, `review-trivial`,
`gh-issue-intake-formats.md`), and no live verb or skill cites it.

The live producers already replace:

- **PR body.** `fabrika build push` writes the body once, and `fabrika build pr-body <pr>` replaces
  it wholesale on a repair.
- **Epic child.** `fabrika build deviations <issue>` edits the one standing `build-deviations`
  marker in place and retracts any older marker of the same account. One marker per issue is
  required, because the reader refuses two conforming `## Deviations` headings as undecidable
  (#6691).

So two answers were written down. §4 said "append", and the code said "replace". A reader following
0216 lands on §4 and reads the opposite of what the verbs do.

## Decision

**A repair round's `## Deviations` section replaces the one before it, on both surfaces, and 0216
§4's round-tagged running log is retired.**

1. **Both surfaces replace.** That is the PR body (0216's `write-code` body, now written by
   `build push` and `build pr-body`) and the epic child's `build-deviations` marker comment. The
   section describes the change as it stands at the reviewed head. It is not a history of rounds, and
   it carries no round tags.
2. **Replacement is cheap because every write is read back.** Under ADR
   [0288](0288-producers-run-consumer-readers.md), the producing verb runs the consumer's reader
   over the exact bytes before it posts, and refuses anything but `Found`. So each round's section is
   proven readable when it is written. A per-round trail would buy no extra readability.
3. **Replacement still covers the whole range.** On the epic child, `build deviations` compares a
   replacement against the standing marker and refuses one that silently drops an entry. An entry
   leaves by being restated with a `Disposition` that says what became of it. This is not the
   retired log: it keeps entries that are still true of the reviewed range, with no round tags and
   no append. That check landed after the ruling, when a child's replaced marker came to describe a
   narrower range than the one a reviewer graded. That is a recurred failure, the one case the
   ruling's lens allows a new check for.

**Binding constraints.**

- No producer appends a round-tagged log to a `## Deviations` section, and no reader expects one.
- 0216 stays byte-identical. Its §4 is retired by this record, not by editing 0216, following the
  way ADR [0344](0344-verdict-repost-appends-below-fence.md) refined ADR
  [0058](0058-sha-bound-verdict-contract.md) rule 2 without touching 0058.

## Consequences

- **One answer.** The `deviations` section of
  [wire-formats.md](../claude-plugins/fabrika/docs/wire-formats.md) now says a repair round replaces
  the section, and its `build-deviations` section already says the marker is edited in place. That
  doc links no decision record, because `portability-guard` reds a decision number or corpus path
  in the text fabrika ships, so this record is reached from the corpus side.
- **Earlier rounds leave no trail in the section.** A tail reviewer reads the disclosure as it
  stands, not what an earlier round said. GitHub keeps no body history, so the old text is gone.
  That is the accepted cost.
- **0216 read literally is now wrong on §4.** Its other rules are not touched here. `grep -rn 0216
  .decisions/` reaches this record, which is where a reader learns §4 is retired.
- **No behaviour changes with this record.** No gate, guard, verb, flag, label or token is added,
  and no refusal is loosened. The corpus is catching up with the code.
