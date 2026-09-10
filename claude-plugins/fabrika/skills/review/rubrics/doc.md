# Doc rubric — the `review-doc` namespace

Applied to the doc-class slice of the diff. Acceptance criteria say whether the PR did the
issue's job; this checklist says whether the doc is well-formed for its surface. A hygiene miss
fails the gate the same as an AC miss.

## What CI already answers — expect, never recompute

Dead internal links, leaked machine-local paths, and ADR-number/index integrity are CI gates.
Read the CI-at-head result; do not re-derive them.

## Hygiene checklist (conjunctive)

- **Right surface.** This repo keeps a separate home for each kind of documentation — the why and
  its history, how the code is shaped, dated findings, the vocabulary, the build state — and the
  content sits in the one its kind belongs to. Read the repo's own contributor doc for which
  directory is which; a why-narrative landing in a code-shape doc is a finding either way.
- **One Diátaxis mode per doc.** A tutorial that drifts into reference, or a how-to that
  re-derives explanation, is a finding — name the mode the doc claims and the paragraphs that
  leave it. The classification procedure and the five recurring mixes live in the
  [`diataxis`](../../diataxis/SKILL.md) skill; fire it on the doc-class slice and state its
  verdict here.
- **Supersession is explicit.** A doc that replaces or contradicts an existing one names it and
  routes the reader; two live docs answering the same question is a finding.
- **Status sanity.** Frontmatter/status lines match the body's claims (a `superseded` doc that
  still speaks in the present tense; an `accepted` ADR whose body says "proposal").
- **Claims trace.** Falsifiable claims about platform/runtime/dependency behavior cite source or
  a real measurement (CLAUDE.md's grounding rule); an intuition stated as fact is a finding.
- **No reference only this repo can resolve, in fabrika's own text.** On a diff under
  `claude-plugins/fabrika/` or `packages/fabrika-cli/src/`, run
  `fabrika guard portability-guard check` and take a red as a finding: a ticket number, a
  decision-record number in either spelling, a decision-corpus path, a hosted issue URL and a name
  the repo declared as its own all resolve nowhere else, and the docs fabrika ships are read
  elsewhere. Raising an allow-list ceiling to fit a new one is itself the finding — that floor only
  shrinks.
- **Prose craft.** Plain words, short sentences, nothing a reader must re-read to parse. The
  levers and the pruning tests live in the
  [`writing-for-agents`](../../writing-for-agents/SKILL.md) skill; apply it verbatim to the
  doc-class slice, reading it inline as a reference, and state its verdict here.

## Not this rubric's

The ADR contradiction sweep and governance-corpus integrity belong to the `governance` skill,
invoked from the skill's governance seam — never graded here.
