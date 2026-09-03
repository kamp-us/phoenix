---
id: 0344
title: A verdict re-post archives the verdict it replaces below a fence, never PATCHes it away (refines 0058 rule 2)
status: accepted
date: 2026-09-01
tags: [pipeline, verdict, review, governance, audit]
---

# 0344 — A Verdict Re-post Archives the Verdict It Replaces Below a Fence, Never PATCHes It Away (refines 0058 rule 2)

**What this decides — and only this:** when a verdict poster writes into a marker comment that
already carries a verdict, it composes — the fresh verdict takes the comment's first line and the
retired one survives below the `<!-- fabrika:superseded -->` fence — instead of replacing the body.
ADR [0058](0058-sha-bound-verdict-contract.md) rule 2's `PATCH`-overwrites-the-body sentence no
longer describes the code.

**What this deliberately does NOT decide: which comment a poster writes into.** That selection is
ADR [0213](0213-verdict-upsert-keyed-on-run-not-shared-author.md)'s (PR, gate, run) upsert key and
it is untouched here — a sibling run still appends a comment of its own, and this run still upserts
its own. This ADR is about the **bytes written into the selected comment**, not about which comment
is selected. Rule 3's latest-wins precedence and ADR [0055](0055-acl-sourced-review-authz.md)'s
author-gate are likewise unchanged.

## Context

Rule 2 made the verdict an upsert so a (PR, gate-namespace) pair resolves to exactly one comment,
and it spelled the mechanism as a destructive edit: a producer "`PATCH`es it … A re-review of a new
head overwrites the same comment with the new verdict + new `@ <sha>`."

**GitHub keeps no comment-body history, so a verdict PATCHed over is a verdict gone.** On PR #7081 a
`FAIL` became a `PASS` at an unchanged head and nothing anywhere recorded that a gate had ever
blocked — the finding, the head it was formed at, and the fact of a reversal all left the record at
once ([#7247](https://github.com/kamp-us/phoenix/issues/7247)). ADR 0213 had already fixed the
cross-run half of this loss by keying the upsert on the posting run; the same-comment half stayed
open, because a run overwriting its *own* prior verdict is exactly what rule 2 told it to do.

PR #7413 closed it in code. The corpus carried no record of the change, so rule 2 still taught a
reader that a re-post destroys the prior verdict — the belief #7247 exists to make false. ADR 0213
refined this same rule by filing a fresh record rather than editing 0058; this one follows that
shape, and 0058's body stays as it landed.

## Decision

**Every verdict re-post is an append inside the one comment: the fresh verdict on top, the retired
one archived below a machine-only fence, and nothing is ever destroyed.**

### 1. The envelope

[`packages/fabrika-cli/src/review/supersede.ts`](../packages/fabrika-cli/src/review/supersede.ts)
owns the bytes. `FENCE` is the literal `<!-- fabrika:superseded -->`; `compose(prior, fresh, on)`
returns `fresh`, the fence, then each retired verdict under a dated
`## Superseded verdict — YYYY-MM-DD` heading, newest first. The retired verdict keeps its own bytes
— its marker line included, trailing whitespace apart. An archive the prior body already carries is
carried through rather than re-headed, so N rounds leave N sections under one fence instead of N
nested envelopes.

Four posters compose through it, and they are the whole emitting surface: `review post`,
`review post --range` (the epic-child range verdict of ADR
[0276](0276-verdict-binds-content-not-only-head.md)), `review-ui post` and `governance post`. Each
takes the same branch — a first post writes the composed body as-is, a re-post into this run's own
marker composes over it.

### 2. Every reader is unchanged, and that is why fresh-goes-on-top

A marker is **the comment's first non-blank line** and nothing else — `firstNonBlankLine` in
[`packages/fabrika-cli/src/wire/marker-line.ts`](../packages/fabrika-cli/src/wire/marker-line.ts),
whose comment states the rule directly: a marker quoted further down is not one. Putting the fresh
verdict on the first line is therefore what keeps `ship gate`, `review verdicts` and `lane prove`
resolving the live verdict without knowing the envelope exists. The archived markers sit below the
fence, are never first, and are read as prose.

**So rule 2's one-resolvable-verdict invariant is intact, exactly as ADR 0213 narrowed it: one
resolvable verdict per (PR, gate-namespace, run).** Only rule 2's account of *how* the comment gets
there was wrong. A reader that must see only the verdict in force calls `split`, which keys on the
fence — an HTML comment that renders as nothing — rather than pattern-matching a heading a human
could retype; `review/write-recency.ts`'s stamp read is that caller. A reader that wants the history
calls `archived`, which hands back each retired verdict opening on its own marker line.

### Binding constraints

- **No verdict poster may replace a body it did not compose.** A re-post into a standing marker
  comment goes through `supersede.compose`; writing `fresh` alone over a body carrying a verdict is
  banned, and a second copy of the envelope's bytes anywhere outside `supersede.ts` is banned with
  it.
- **The fresh verdict occupies the comment's first non-blank line.** Any ordering that puts an
  archived marker there breaks every reader at once, silently and in the permissive direction.
- **The fence stays an HTML comment.** It is a machine boundary, not a rendered heading; a reader
  keying on the human-readable heading instead is keying on bytes a person can retype.

## Consequences

- **A reversal is auditable.** The `FAIL` a later `PASS` supersedes stays on the thread, dated and
  in its own bytes, so #7081's question — was this ever blocked, and on what — is answerable from
  the comment alone.
- **Rule 2 read literally is now wrong, and this record is where a reader finds that out.** 0058's
  text is immutable, so the mechanism sentence stands there uncorrected; the corpus resolves it the
  way it resolved 0213's refinement of the same rule — by a later record naming it.
- **The comment grows with every round, without bound.** Each re-post adds a section and drops
  none, so a long repair loop leaves a long comment.
  [#7420](https://github.com/kamp-us/phoenix/issues/7420) owns that surface; nothing here caps it.
- **The opposite-polarity guard is complementary and unchanged.** A poster still refuses to retire a
  standing verdict of the other polarity until `--supersede` says so out loud. Archiving makes the
  retirement *visible*; that flag is what makes it *deliberate*.
- **No behaviour changes with this record.** The code landed in PR #7413; this is the corpus
  catching up.
- **Relationship:** refines [0058](0058-sha-bound-verdict-contract.md) rule 2's mechanism, and only
  that — rule 2's uniqueness invariant (as narrowed by
  [0213](0213-verdict-upsert-keyed-on-run-not-shared-author.md)), rule 3's precedence and
  [0055](0055-acl-sourced-review-authz.md)'s author-gate are all untouched.

## Records

No vocabulary impact. "Superseded verdict" and "the supersede fence" name an existing artifact in
existing terms — the SHA-bound verdict of `.glossary/TERMS.md` plus the fence byte string
`supersede.ts` already owns — so no term is coined or redefined here.
