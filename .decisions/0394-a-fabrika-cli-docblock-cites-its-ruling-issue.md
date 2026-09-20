---
id: 0394
title: A fabrika-cli docblock cites its ruling issue with an @ruling tag, not an ADR number
status: accepted
date: 2026-09-15
tags: [fabrika, portability, comments, governance, guards]
---

# 0394 — A fabrika-cli docblock cites its ruling issue with an @ruling tag, not an ADR number

**What this decides:** a docblock under `packages/fabrika-cli/` is exempt from the ADR-citation
requirement when it cites the ruling issue instead, in one spelling — an `@ruling` tag naming the
hosted issue or comment URL. `portability-guard` accepts that citation under that tree and reds
every other repo-bound reference exactly as before. Everywhere else in phoenix the ADR pointer stays
the rule.

Founder ruling, 2026-09-15 PT, recorded under [#8807](https://github.com/kamp-us/phoenix/issues/8807)
R4.1:
[the ruling comment on #9141](https://github.com/kamp-us/phoenix/issues/9141#issuecomment-5689590985).
This record transcribes it; the choice is not the author's.

## Context

Two live rules could not both be satisfied by a docblock under `packages/fabrika-cli/src/`.

**The pointer rule.** `AGENTS.md` says comments explain a local invariant the code cannot express,
routes rationale to the decision corpus, and hands comment review to
[`deslop-comments`](../claude-plugins/fabrika/skills/deslop-comments/SKILL.md). That skill's
**COLLAPSE** verdict reads "a multi-paragraph docblock re-explaining a why that already has an ADR or
a pattern doc, shrunk to one pointer line naming the record or the doc it points at", and its
**REHOME** verdict ends "replace the docblock with a pointer to it". [ADR
0119](0119-comment-discipline-is-an-independent-review-criterion.md) makes that rubric the
independent reviewer's standing criterion, applied verbatim.

**The portability rule.** `packages/fabrika-cli/src/guard/portability.ts` declares
`DECISION_NUMBER = /\bADRs?[\s-]+\[?\d{3,4}\b/g` and `DECISION_LINK = /\.decisions\//g`, with
`SCAN_ROOTS = ["claude-plugins/fabrika", "packages/fabrika-cli/src"]`. So `ADR 0388` and a
decision-corpus path are each a hit under that tree, and `ISSUE`, `URL_REF` and the declared repo
names caught every other spelling a pointer could reach for. fabrika installs into repositories that
are not this one, and a decision-record number means something else in the next repo — the guard is
right on its own terms.

The collision is not theoretical. PR [#9135](https://github.com/kamp-us/phoenix/pull/9135) made the
COLLAPSE edit the reviewer asked for, went red on `build check --surface code`, reverted it, and
recorded the revert as a declined-guidance deviation — one review round spent on a rule pair nobody
could satisfy. [#8842](https://github.com/kamp-us/phoenix/issues/8842)'s acceptance criteria ask a
docblock to "cite that ADR by repo-relative path" *and* keep `portability-guard check` green, which
against `DECISION_LINK` at main is unbuildable as written.

## Decision

**A fabrika-cli docblock cites its governing choice by naming the ruling issue, not an ADR.** The
citation has one spelling, an `@ruling` tag followed by the hosted issue or pull-request URL:

```ts
/**
 * ...
 * @ruling https://github.com/kamp-us/phoenix/issues/9141#issuecomment-5689590985
 */
```

`portability-guard` admits that citation: `scanFile` computes the tag's span and drops any hit
inside it. Three properties bound the carve-out.

- **Path-scoped to `packages/fabrika-cli/`.** The ruling names verb docblocks, and no matcher can
  read "is this a verb docblock" off a line of text, so the guard scopes by the tree the ruling
  named. `claude-plugins/fabrika` is deliberately outside: a skill's reader is the adopter's agent,
  and a link it cannot resolve teaches that agent nothing, so shipped skill text keeps the
  self-contained sentence.
- **Span-scoped, not line-scoped.** Only the tag and its URL are exempt. Prose sharing the line is
  scanned exactly as before, so `@ruling <url> — and see #4312 too` still reds on `#4312`.
- **The URL is required.** `@ruling see the thread` matches nothing and buys no exemption, so the
  tag cannot become a blanket suppressor.

Nothing else moves. No ceiling in `portability-guard.config.json` changes, and the five matchers are
untouched.

**The rubrics say so where a reviewer meets the finding.** `deslop-comments`'s COLLAPSE and REHOME
verdicts, `review`'s code / doc / skill rubrics and `build`'s code reference each carry the
carve-out, so the reviewer who would otherwise raise the collapse finding reads the exception at the
same place as the rule.

**What #8842 should do.** Its criterion "cite that ADR by repo-relative path" is replaced by the
`@ruling` tag naming the issue that ruled `parkCause`. Both of its criteria then hold together: the
docblock carries a citation, and `portability-guard check` stays green.

## Consequences

- **Two citation styles in this repo, and that trade-off is accepted by the ruling.** ADR pointers
  for product and platform choices; an issue citation for an engine ruling inside fabrika-cli. A
  reader of a fabrika-cli docblock now has to know which tree they are in to know which form to
  expect. The alternative — teaching the guard a repo-neutral form such as a record *title* — was
  not ruled, and a title match is a fuzzy matcher on a fail-closed gate.
- **The 2026-09-10 ruling on the same issue is superseded.** That earlier comment ruled portability
  the winner outright, with the docblock stating its why in one plain sentence and no pointer at
  all. The 2026-09-15 ruling keeps the citation and moves its target, so a fabrika-cli docblock is
  no longer required to be self-contained.
- **`build check` reds one round later, not never.** A builder who writes `ADR 0388` under
  `packages/fabrika-cli/src` still reds. The remedy is now a spelling change rather than a revert,
  which is the whole point.
- **No sweep lands here.** No docblock is rewritten and no ceiling moves with this record; applying
  it across the existing docblocks belongs to epic
  [#8281](https://github.com/kamp-us/phoenix/issues/8281)'s children.
