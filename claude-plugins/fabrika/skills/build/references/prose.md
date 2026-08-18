# Surface rubric — prose

Docs, ADRs, pattern docs, briefs, glossary entries. `fabrika build check` validates link
resolution and doc-surface placement here.

- **Pick the page's one mode before writing it** — tutorial, how-to, reference, or explanation.
  The [`diataxis`](../../diataxis/SKILL.md) skill carries the procedure and maps each mode to the
  home that owns it; a page serving two reader-needs splits instead of blending.
- **Put the fact in its one home**: `README` = product front door; `DEVELOPMENT.md` = builder
  state; `.decisions/` = why + history; `.patterns/` = how code is shaped; `reports/` = dated
  snapshots; `.glossary/` = vocabulary. A fact in two homes is a fact that drifts.
- **Standard markdown links with real resolvable paths** — no wikilinks, no placeholders, no
  machine-local paths (leak-guard reds them).
- **Turkish for product/brand, English for technical** (`.glossary/LANGUAGE.md` is canonical).
- **Point, don't restate**: a paragraph re-deriving an ADR's why collapses to a pointer. A rule
  quoted in prose is a second source of truth; cite it by id instead.
- **An ADR is authored via `/adr`**, never hand-dropped into `.decisions/` from here.
- **Never rewrite a filed issue body** — append a dated `## Amendment`; GitHub keeps no history.
- **Sentence-level writing discipline lives in the shared writing rubric skill** (consumed by
  `build` and `review` both — the one ruled leaf-promotion, #4891). This file carries only
  placement and sourcing rules; do not grow style guidance here.
