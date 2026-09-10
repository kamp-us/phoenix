# Surface rubric — prose

Docs, decision records, pattern docs, briefs, glossary entries. `fabrika build check` validates link
resolution and doc-surface placement here.

- **Pick the page's one mode before writing it** — tutorial, how-to, reference, or explanation.
  The [`diataxis`](../../diataxis/SKILL.md) skill carries the procedure and maps each mode to the
  home that owns it; a page serving two reader-needs splits instead of blending.
- **Put the fact in its one home**: the README is the product front door; the development doc is
  builder state; the decision corpus is why + history; the pattern docs are how the code is shaped;
  a reports directory holds dated snapshots; the glossary holds vocabulary. A fact in two homes is
  a fact that drifts. This repo's own homes are whatever its root docs declare — read them rather
  than assuming another repo's layout.
- **Standard markdown links with real resolvable paths** — no wikilinks, no placeholders, no
  machine-local paths (leak-guard reds them).
- **Follow the repo's own language rule** where it has one: which surfaces are written in the
  product's language and which stay technical English is the repo's call, stated in its glossary.
- **Point, don't restate**: a paragraph re-deriving a decision record's why collapses to a pointer.
  A rule quoted in prose is a second source of truth; cite it by id instead.
- **A decision record is authored via `/adr`**, never hand-dropped into the decision corpus from
  here.
- **Never rewrite a filed issue body** — append a dated `## Amendment`. The tracker keeps no body
  history, so an overwrite destroys what the issue used to say with nothing to recover it from.
- **Sentence-level writing discipline lives in
  [`writing-for-agents`](../../writing-for-agents/SKILL.md)**, consumed by `build` and `review`
  both, so one rewrite of a rule reaches both stages. Read it inline as a reference. This file
  carries placement and sourcing rules alone; style guidance belongs there.
