---
id: 0099
title: The architecture-audit pipeline skill emits triageable issues (not a repo doc); `.glossary/` is a 4th committed doc surface; `glossary` + `architecture-audit` join the pipeline suite
status: accepted
date: 2026-06-20
tags: [pipeline, doc-surfaces, glossary, architecture-audit, plugin]
---

# 0099 — The architecture-audit pipeline skill emits triageable issues (not a repo doc); `.glossary/` is a 4th committed doc surface; `glossary` + `architecture-audit` join the pipeline suite

## Context

A whole-repo architecture-audit sweep was run from a **personal** off-repo
`/audit-architecture` skill, then funneled through `report → triage` (#851–#864). Two
structural problems surfaced (epic [#872](https://github.com/kamp-us/phoenix/issues/872)):

1. **The repo's ubiquitous-language spine is mis-homed.** The two vocabularies the
   pipeline already *speaks* live only in personal, off-repo locations: the **domain
   vocabulary** (pano, vote, künye, fate, LiveDO — the nouns of phoenix) in a personal
   vault file, and the **architecture vocabulary** (module / interface / depth / seam /
   adapter / leverage / locality + the deletion test) *inside* the personal
   `audit-architecture` skill's `LANGUAGE.md`. Because both are off-repo, audit/report
   agents cited pointers (`terms.md:103`, `LANGUAGE.md`) that **404 in the repo** — triage
   had to strip them by hand from every #851–#864 body. This violates the repo's own
   "project knowledge → repo" rule (project-general facts belong in
   `.decisions`/`.patterns`/`CLAUDE.md`, not a personal vault) and is the mechanism behind
   the audit's own cluster-16/#864 finding that "the glossary lags shipped surfaces" — a
   glossary nobody but its author can see rots.

2. **The architecture audit itself exists only as a personal skill.** Just proven
   high-value across 29 units / 130 candidates / 14 filed issues this session, it can't be
   invoked, code-gated, or run as part of the pipeline.

The fork that needs **recorded human-grade judgment** — not a codebase lookup — is *how
the in-repo audit skill should emit its output*. The personal `audit-architecture` skill
writes a single read-only vault audit doc. That shape is wrong for this pipeline: `triage`
and `write-code` are **per-issue**, so a single mega-audit-doc is un-triageable and
un-drainable. Two adjacent decisions ride with it — where the repo's vocabulary should
live, and that the audit + a glossary-maintainer become first-class pipeline skills — and
this ADR records all three so the epic's later children (`#882`–`#888`) build against a
settled decision. (`#886`, the `architecture-audit` skill, carries `requires: #884` — this
decision — precisely because the skill's whole shape is what is settled here.)

This is **platform/infra**, so engineering leads the call (ADR
[0078](0078-product-driven-decisions-by-default.md)).

## Decision

### 1. The `architecture-audit` skill emits triageable GitHub issues — one per deduped finding — not a repo doc

The in-repo `architecture-audit` pipeline skill's output is **triageable GitHub issues:
one issue per consolidated, deduped finding**, filed through the existing `report` intake
path (raw `status:needs-triage`), **not** a read-only repo/vault audit doc. This is the
**key divergence from the personal `audit-architecture` skill** (which writes a single
vault doc).

The rationale: `triage` and `write-code` are **per-issue** stages, so a single
mega-audit-doc is **un-triageable and un-drainable** — it can't enter the
`report → triage → plan-epic → … → ship-it` pipeline as a unit of work. Emitting **one
issue per deduped finding** routes each finding into that existing pipeline, where it is
classified, prioritized, and drained on its own merits. The working prototype is *this very
session's* `report → triage` run (#851–#864): the dedup + draft + file workflow that
produced those issues is exactly what the skill formalizes — the skill is a formalization
of a run that already works, not a new mechanism.

The skill files findings **type-blind**, exactly as [`report`](https://github.com/kamp-us/phoenix/blob/main/claude-plugins/kampus-pipeline/skills/report/SKILL.md)
does: it does not pre-type or pre-prioritize a finding — that is triage's call. It does
**not** invent a parallel intake path; it reuses `report`'s.

### 2. `.glossary/` is a 4th committed doc surface

The repo's committed doc surfaces today are **three**: `CLAUDE.md` (current-state-for-
builders), `.decisions/` (the why + history), `.patterns/` (how-the-current-code-is-shaped
— per the CLAUDE.md "Doc surfaces" taxonomy). **`.glossary/` is added as a 4th surface: a
vocabulary register**, the canonical home for the project's ubiquitous language. None of
the existing three is a vocabulary register — the phantom-pointer incident (off-repo
pointers that 404) shows the vocabulary needs its own *resolvable in-repo* home.

The surface holds two files with a deliberate **churn split**:

- `.glossary/TERMS.md` — the **domain vocabulary** (the nouns of phoenix). **Churns**:
  maintained by the new `glossary` skill (bootstrap + incremental update), ported from the
  off-repo vault file, scrubbed.
- `.glossary/LANGUAGE.md` — the **architecture vocabulary** (module / interface / depth /
  seam / adapter / leverage / locality + the deletion test). A **near-frozen** static
  commit, extended with phoenix structural terms.

**Filename convention: UPPERCASE, scoped to `.glossary/` only.** `.glossary/` files are
UPPERCASE (`TERMS.md`, `LANGUAGE.md`) to match the existing top-level-doc idiom
(`CLAUDE.md`, `README.md`). This scoping is **explicit and bounded**: `.decisions/` and
`.patterns/` keep their kebab-case filenames — UPPERCASE is **not** a repo-wide rule, it is
local to `.glossary/`.

`CLAUDE.md`'s vocabulary **moves into `.glossary/` and `CLAUDE.md` points at it** rather
than duplicating it, so there is **one source**, not a duplicated contract between
`CLAUDE.md` and the glossary (the duplicated-contract trap this surface exists to avoid).

### 3. `glossary` + `architecture-audit` join the `kampus-pipeline` skill suite

Two new skills join `claude-plugins/kampus-pipeline/skills/`:

- **`glossary`** — maintains `.glossary/TERMS.md` (a bootstrap mode to seed the domain
  vocabulary once, and an incremental-update mode to keep it current as surfaces change).
- **`architecture-audit`** — the in-repo audit twin. It **reads `.glossary/*`** for its
  vocabulary (rather than carrying its own copy — a second copy would re-create the
  duplicated-contract problem this epic exists to remove) and **carries its own method
  docs `SMELLS.md` + `DEEPENING.md`**. Its output is per Decision 1 (triageable issues).

Both follow the existing pipeline-skill shape (`report`/`triage`) and are **repo-agnostic**
per the formats-contract target resolution (ADR [0062](0062-repo-as-config-plugin.md) §1),
so they operate on whatever repo they're installed into. They live in the dedicated plugin
subdir `claude-plugins/kampus-pipeline/skills/` per the multi-plugin marketplace layout
(ADR [0087](0087-plugin-dedicated-subdir-source.md)).

### Grounding in existing decisions

- ADR [0087](0087-plugin-dedicated-subdir-source.md) — the new skills live under the
  dedicated `claude-plugins/kampus-pipeline/skills/` subdir source.
- ADR [0062](0062-repo-as-config-plugin.md) — the skills are repo-agnostic (target
  resolution); the `.glossary/` surface is repo-owned config the pipeline reads.
- ADRs [0063](0063-skills-are-code-gated.md) / [0073](0073-review-skill-gate.md) — skills are
  code-gated; the two new skills are reviewed by `review-skill`, and a gate-critical skill
  is control-plane (human-merged, ADR [0053](0053-control-plane-boundary.md) /
  [0065](0065-gate-critical-skills-are-blocking.md)).
- ADR [0078](0078-product-driven-decisions-by-default.md) — this is platform/infra, so
  engineering leads the decision.

## Consequences

- **The repo owns its language.** Every pipeline skill (write-code, review-code, plan-epic,
  triage, the audit) has a single, resolvable in-repo vocabulary source; issue pointers to
  `.glossary/*` resolve instead of 404-ing, ending the phantom-pointer / hand-strip incident.
- **Audit findings drain through the normal pipeline.** Because the audit emits one
  triageable issue per finding, each is classified and prioritized on its own merits and
  drained by `write-code` — no un-triageable mega-doc, no bespoke audit-doc intake. The cost
  is more issues filed per audit run (one per deduped finding), which is the point: that is
  what makes them drainable.
- **A 4th doc surface to keep distinct.** Readers and the "Doc surfaces" taxonomy in
  `CLAUDE.md` must now distinguish four surfaces; the UPPERCASE filename rule is **scoped to
  `.glossary/`** and must not bleed into `.decisions/`/`.patterns/`. `CLAUDE.md` points at
  `.glossary/` rather than restating its vocabulary — the single-source discipline must hold
  or the duplicated-contract returns.
- **The glossary can rot if unmaintained.** Repo-owning the vocabulary does not by itself
  keep it current — that is the `glossary` skill's job, and the explicitly **split-off /
  non-MVP** freshness gate (#888: `review-code` flags a PR adding a new surface that doesn't
  touch `.glossary/TERMS.md`) is the eventual enforcement. This ADR settles the surface and
  the skills; it does **not** mandate the freshness gate (that child stands alone).
- **Two more gate-critical-adjacent skills.** The new skills are control-plane (ADR
  0063/0073), so their PRs are human-merged (ADR 0053/0065) — this governs *who merges*, not
  the plan.
- **Scope of this ADR.** It records the **decisions** the epic settles; it does **not**
  write the skills or the glossary files. Those are the epic's other children (#882–#887);
  this child (#884) only produces the decision record they build against.
