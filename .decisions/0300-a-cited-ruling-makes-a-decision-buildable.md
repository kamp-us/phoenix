---
id: 0300
title: A recorded founder ruling makes a decision issue buildable as transcription, never as judgement
status: accepted
date: 2026-08-19
tags: [fabrika, pipeline, decisions, agents]
---

# 0300 — A recorded founder ruling makes a decision issue buildable as transcription, never as judgement

**What this decides:** Once a founder has written the ruling down on the issue, an agent may pick
that decision issue up and write the ruling into the ADR or skill amendment it names. It may not
decide anything itself: it points at the comment carrying the ruling, or it refuses.

## Context

The `build` skill refused every `type:decision` issue outright — the deliverable is a recorded
choice, and choosing is human work. That refusal was written as an absolute, so it also caught the
case where the choosing had already happened. On 2026-08-18 it bit twice in one day:
[#5909](https://github.com/kamp-us/phoenix/issues/5909) and
[#5879](https://github.com/kamp-us/phoenix/issues/5879) both carried a founder ruling recorded as an
issue comment, and both parked as builder-refused with nothing left to do but copy the ruling into a
file. Every settled decision was costing a founder round-trip to transcribe.

The founder ruled on that on
[#5879, comment 5335398768](https://github.com/kamp-us/phoenix/issues/5879#issuecomment-5335398768)
(option 2). This ADR records that ruling.

The pool exclusion is a different fence and stays: `build pick` never offers a `type:decision` issue,
because a blind pick has nothing to cite. A cited-ruling decision issue is entered by number.

## Decision

**A `type:decision` issue is claimable by an agent when, and only when, the build can cite a founder
ruling comment recorded on that issue; the deliverable is transcribing that ruling into the ADR or
amendment it names.**

The citation is the fence, and it is what keeps deciding human-only. The comment exists on the board
before the claim, written by a human, and the builder's whole judgement is reading it — not deciding
whether the question is settled.

**Binding constraints.**

- The refusal is the default branch. With no citable ruling comment on the issue, a `type:decision`
  claim is refused exactly as it was before this ADR.
- The builder cites a comment. "This looks settled", "the thread converged", or a ruling inferred
  from anything other than a comment recording it is not a citation.
- The builder records the cited comment's URL in the PR body, so the ruling it transcribed is
  readable off the merge record.
- The builder transcribes only what the ruling says. Filling a gap the ruling left open is deciding,
  and it goes back to the founder.
- `build pick`'s type exclusion is unchanged: this route is entered by number, never picked.

## Consequences

A ruled decision now costs one agent lane instead of one founder round-trip, which is the whole
point — the ruling was already the expensive part.

The cost is that the fence is prose the builder reads, not a check the CLI runs. `build claim`'s
audience axis already admits a `type:decision` issue that triage stamped `ready-for:agent`, so the
refusal and its arm both live in the skill. A builder that transcribes without a citation is caught
at review, not at claim time. Mechanizing the citation check is a separate question and a separate
ticket; nobody has asked for it yet, and the review gate reads the PR body where the URL lands.

## Records

no vocabulary impact
