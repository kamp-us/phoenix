# Doc rubric — the `review-doc` namespace

Applied to the doc-class slice of the diff. Acceptance criteria say whether the PR did the
issue's job; this checklist says whether the doc is well-formed for its surface. A hygiene miss
fails the gate the same as an AC miss.

## What CI already answers — expect, never recompute

Dead internal links, leaked machine-local paths, and ADR-number/index integrity are CI gates.
Read the CI-at-head result; do not re-derive them.

## Hygiene checklist (conjunctive)

- **Right surface.** The content sits where its kind lives: why/history → `.decisions/`,
  code-shape → `.patterns/`, dated findings → `reports/`, vocabulary → `.glossary/`, build state →
  `DEVELOPMENT.md`. A why-narrative landing in a pattern doc is a finding.
- **One Diátaxis mode per doc.** A tutorial that drifts into reference, or a how-to that
  re-derives explanation, is a finding — name the mode the doc claims and the paragraphs that
  leave it.
- **Supersession is explicit.** A doc that replaces or contradicts an existing one names it and
  routes the reader; two live docs answering the same question is a finding.
- **Status sanity.** Frontmatter/status lines match the body's claims (a `superseded` doc that
  still speaks in the present tense; an `accepted` ADR whose body says "proposal").
- **Claims trace.** Falsifiable claims about platform/runtime/dependency behavior cite source or
  a real measurement (CLAUDE.md's grounding rule); an intuition stated as fact is a finding.
- **Prose craft.** Plain words, short sentences, nothing a reader must re-read to parse; once
  fabrika's shared writing rubric skill lands, apply it verbatim instead of this line.

## Not this rubric's

The ADR contradiction sweep and governance-corpus integrity belong to the `governance` skill,
invoked from the skill's governance seam — never graded here.
