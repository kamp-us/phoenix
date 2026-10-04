---
id: 0457
title: An issue's comment thread is served by a `fabrika build comments` verb, never by rewording the read rule
status: accepted
date: 2026-10-04
tags: [fabrika, pipeline, build, agents]
---

# 0457 — An issue's comment thread is served by a `fabrika build comments` verb, never by rewording the read rule

**What this decides:** a builder that needs the comments on an issue gets them from a new verb,
`fabrika build comments <n>`, and the `build` skill's rule that comments are read only through a
verb stays as written.

## Context

The `build` skill says issue bodies and comments are "each read only through a verb, never through
a raw fetch" ([`build/SKILL.md`](../claude-plugins/fabrika/skills/build/SKILL.md)). No verb serves
an issue's comment thread. `build issue` prints the body and the acceptance criteria. The comment
readers that exist are narrow: `build verdicts` and `review verdicts` serve gate verdicts, and
`decision ruling` answers whether a ruling stands and prints its URL, not its text.

So a builder that has to cite or read a comment breaks the rule to do it.
[#7814](https://github.com/kamp-us/phoenix/issues/7814) filed that from a lane that needed a
comment URL to discharge a criterion by citation and ran a raw `gh api` call to get it. ADR
[0300](0300-a-cited-ruling-makes-a-decision-buildable.md) puts the same read on the critical path
of every transcription lane: the builder must read the ruling comment it cites.

The reader already exists one layer down.
[`io/issues.ts`](../packages/fabrika-cli/src/io/issues.ts) exports `listComments`, and
[`build/claim.ts`](../packages/fabrika-cli/src/build/claim.ts) walks the full thread with it and
reports only a count.

#7814 put two routes to the founder: grow a verb, or reword the rule so a driver hands the builder
the comment URLs in its brief. It also asked, if a verb is grown, whether it lands under `build` or
as a shared reader the `review` and `decision` verbs also sit on.

The ruling is recorded on
[#7814, comment 5625053477](https://github.com/kamp-us/phoenix/issues/7814#issuecomment-5625053477),
2026-09-10. It was written by an EA session on the founder's behalf, under the standing ruling it
cites on [#8807](https://github.com/kamp-us/phoenix/issues/8807) that pipeline mechanics are the
driver's to decide. Its ruled line:

> **Ruled:** build `fabrika build comments <n>` as a thin surface over the existing listComments reader

This record is that ruling written down, per ADR 0300. Its source is #7814.

## Decision

**The gap closes by growing the verb: `fabrika build comments <n>` serves an issue's comment
thread, built as a thin surface over the existing `listComments` reader.**

- **Route 1 is ruled.** The verb is grown. The skill's read rule is not reworded, and a driver does
  not owe a builder comment URLs in its brief.
- **The verb lands under `build`.** The ruling names it `fabrika build comments <n>`.
- **It is a thin surface.** It sits on the `listComments` reader `io/issues.ts` already exports. It
  adds no second comment reader.

The ruling does not set the verb's output fields, its exit codes, or how it labels the content it
serves as untrusted. #7814 suggests id, author, created-at, URL and body per comment; that is the
filer's suggestion, not part of the ruling.

**Binding constraints.**

- The verb is named `fabrika build comments <n>` and belongs to the `build` group.
- It reads through `listComments`. A change that gives it its own GitHub read is a different
  decision.
- The `build` skill's "each read only through a verb, never through a raw fetch" sentence stays.

## Consequences

**The read rule becomes one a builder can keep.** A lane that cites a comment, and a transcription
lane reading the ruling it cites, has a verb to call. A builder under a strict permission profile
no longer stalls where `gh api` is denied.

**This record builds nothing.** The verb is a separate build. Until it lands, the gap #7814
describes is still open, and a transcription lane still has no verb that prints a ruling's text.
This record's own lane met that: it read the one cited ruling comment with a raw `gh api` call.

**`review` and `decision` keep their own verbs.** They already share the IO reader the new verb
sits on, so the ruling moves nothing of theirs.

## Records

- Source: [#7814](https://github.com/kamp-us/phoenix/issues/7814) and its ruling comment.
- Related: [#7393](https://github.com/kamp-us/phoenix/issues/7393), the same gap on the board-write
  side.
- No vocabulary impact.
