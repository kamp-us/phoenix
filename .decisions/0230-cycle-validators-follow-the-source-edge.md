---
id: 0230
title: Cycle validators widen a skill's scan surface across its own source edges — one hop, fail-closed
status: superseded by [0303](0303-retire-kampus-pipeline-plugin.md)
superseded_by: 0303
date: 2026-07-30
tags: [pipeline, skills, guards, control-plane]
---

# 0230 — Cycle validators widen a skill's scan surface across its own source edges

**What this decides:** `kp_skill_shell_surfaces` — and through it both cycle validators — resolves a
cycle-aware skill's scan surface as `SKILL.md` + the skill's own `scripts/*.sh` **plus every
`shared/scripts/*.sh` that one of those files demonstrably sources**, one hop, fail-closed on an
edge that will not resolve. Scope inclusion is keyed on **demonstrated dependency**, never on
directory membership. This is shape (1) of #4505; shapes (2) and (3) are rejected below.

## Context

Both cycle validators prove each cycle-aware skill's wiring by `grep -qF`-ing the canonical probe
literal `contents/product-development-cycle.md` across a surface that
`claude-plugins/kampus-pipeline/skills/shared/lib/common.sh`'s `kp_skill_shell_surfaces` resolves as
`<skill>/SKILL.md` + every `*.sh` **under the skill's own directory**. `shared/` is deliberately
excluded, so one skill's marker cannot satisfy another skill's per-skill check (#4470, PR #4473).

The extraction programme's other rule — **source the shared helper, don't copy it** (#4435) — moves
that literal out of a skill's own surface. A skill that correctly sources
`shared/scripts/cycle-doc-probe.sh` no longer carries the probe as executable code anywhere the
validators look, so its only satisfiable token is a **comment**, and the validator cannot tell an
honest delegation citation from a marker planted to pass a grep.

**The tension is live on `main`, not hypothetical.** Measured on the branch base of this ADR:

```
$ grep -nF "contents/product-development-cycle.md" \
    plan-epic/scripts/cycle-doc-probe.sh review-code/scripts/cycle-doc-probe.sh \
    write-code/SKILL.md ship-it/scripts/step5b-release-queue.sh
ship-it/scripts/step5b-release-queue.sh:19:  … gh api "repos/$REPO/contents/…"   ← executable
review-code/scripts/cycle-doc-probe.sh:21:  … gh api "repos/$REPO/contents/…"   ← executable (a COPY)
write-code/SKILL.md:1233, 1761:            … gh api "repos/$REPO/contents/…"   ← executable
plan-epic/scripts/cycle-doc-probe.sh:10:   # … `contents/…` …                   ← a COMMENT, and the only match
```

`validate-cycle-presence.sh` exits 0 with `ok: plan-epic cites the canonical cycle-doc probe`. The
one skill that did the right thing — sourced the shared probe — is the only one whose evidence is
prose; the three still green on real code are green because two of them have not been extracted yet
and the third keeps a second copy of the probe. The guard rewards the duplication it exists
alongside, and its own docblock claim ("proves the present branch is real wiring and not dead
prose") is false exactly where the programme is correct.

**The repo already discriminates this way.** `packages/pipeline-cli/src/skill-shell-surface.ts`
(`resolveSection`, #4498) resolves a section's surface as its heading slice **plus every
`scripts/*.sh` the slice sources** — a source-edge widening, already shipped, already tested. This
ADR extends the same idea one hop further for the cycle validators' shell-side resolver.

## Decision

**`kp_skill_shell_surfaces "$skills_dir" "$skill"` returns, in addition to today's own-surface
files, every `shared/scripts/*.sh` that a file in that own surface sources.** Four binding rules:

1. **The edge must be executable, and it must live in this skill's own files.** A path enters the
   surface only via a source line — a line whose first non-blank token is `.` or `source` and whose
   argument resolves under `shared/scripts/` — in one of the skill's own files. A `#`-prefixed
   comment naming the path is not an edge. This is what preserves #4470: a shared file is credited
   to skill A because **A's own text executes it**, so a skill that does not source it gets nothing.
2. **One hop, declared — no transitive closure.** Only files sourced *directly* by the skill's own
   surface are followed. A literal hidden two hops deep is a FAIL, and the fix is to source it
   directly. A closure would re-open the whole-tree fold rule 1 exists to prevent, and would make
   the surface depend on the shared corpus's internal shape.
3. **Widen, never replace.** The own-surface files stay in the returned surface unconditionally. The
   edge adds; it does not substitute.
4. **A named edge that will not resolve is UNRESOLVED ⇒ FAIL, never a fallback.** An edge whose
   target is missing or unreadable makes the surface UNKNOWN. The validator fails, loudly, rather
   than silently scanning the narrower own-surface set and reporting a pass over an unevaluated path
   ([ADR 0092](0092-gates-fail-closed-on-zero-scope.md) / §ZS). "Could not read the surface" is not
   "the literal is absent", and it is certainly not "ok".

### What the validators prove after this change

For each cycle-aware skill: **either the skill's own executable surface carries the canonical probe
literal, or the skill's own surface executes a shared file that does.** That is *real wiring* — the
docblock intent — and the mechanism now agrees with it. A fully-extracted skill's honest citation
comment becomes documentation rather than the load-bearing token, and a comment planted only to pass
the grep no longer satisfies a fully-extracted skill.

### The site is the resolver, not the probe grep

The change lands in `kp_skill_shell_surfaces` because **each validator runs three independent greps
off the one `surfaces` array**: the probe literal, the present-gate / absent-no-op regex, and the
per-skill action regex. `CYCLE_DOC=absent` — the absence validator's needle for both `write-code`
and `review-code` — also lives in `shared/scripts/cycle-doc-probe.sh`, so it is subject to the same
erosion. Widening only the probe grep would repair one of three checks and leave the other two to
fail as soon as their skills extract. One resolver, one widening, all six greps.

### Rejected shapes

- **(2) Alternation on the sourcing line** — accept the literal *or* a proven source of the shared
  helper. Rejected: it is name-keyed, never verifying that the sourced file carries the probe at all,
  and it fixes only the grep it is written into (see the site argument above).
- **(3) Promote the comment to a contract marker.** Rejected: it makes "a docblock satisfies the
  guard" the stated design, permanently lowering the floor from executable code to prose. That is a
  guard weakening with no compensating gain, on a guard whose whole claim is the opposite.
- **A fourth — copy the probe into each skill** — was never live: it re-introduces the N-copies drift
  the shared helpers exist to remove, and `review-code/scripts/cycle-doc-probe.sh`'s surviving copy is
  the drift risk, not the model.

### Knowingly traded, stated rather than glossed

- **The markdown-prose floor in `SKILL.md` is unchanged.** `SKILL.md` is markdown, and a fenced block
  satisfies `grep -qF` exactly as a paragraph does. This ADR removes the *new* degradation (a comment
  as a fully-extracted skill's only satisfiable token); it does not solve the pre-existing softness of
  grepping prose. Distinguishing fenced shell from narrative is a separate problem in epic #4435's
  scan-surface class and is left open.
- **The edge is matched as text.** A line crafted to look like a source line but never executed would
  pass. The `.`/`source`-anchored match plus rule 4's must-resolve requirement is the same standard
  the rest of the corpus's static checks hold; it is not a proof of execution.
- **Two skills that source the same helper are both credited from the same file.** That is correct,
  not a leak: both genuinely execute it, and each needed its own source line to get there.

## Consequences

- **#4470's property is preserved, not traded.** Its exclusion was on *directory membership*, which
  this decision does not relax — `shared/` remains outside every skill's surface by default. What is
  added is per-skill, per-edge, evidence-bearing inclusion.
- Extracting a cycle-aware skill's probe into a sourced shared helper is now the green path; the
  guard stops penalising the correct move.
- `review-code/scripts/cycle-doc-probe.sh`'s duplicated probe becomes removable — it can source the
  shared implementation and stay green on the edge.
- A new fail mode exists on purpose: a skill whose source edge points at a missing file goes red
  rather than quietly narrowing. That is the intended direction (ADR 0092).

### Follow-up implementation scope (the named surfaces that change)

1. **`claude-plugins/kampus-pipeline/skills/shared/lib/common.sh`** — `kp_skill_shell_surfaces` gains
   the one-hop, `.`/`source`-anchored, fail-closed edge resolution above. It must also stop
   discarding `find`'s exit status (#4487), since an unresolved own-surface read is the same UNKNOWN
   as an unresolved edge.
2. **`skills/validate-cycle-presence.sh` / `skills/validate-cycle-absence.sh`** — grep logic
   unchanged. Their docblocks restate the surface ("SKILL.md + own `scripts/*.sh` + the shared
   scripts this skill sources"), and the emitted `scanned scope` line marks edge-resolved paths
   distinctly from own-surface paths so the ADR 0092 §1 emission stays honest about *why* a file was
   read. Both keep `set -uo pipefail` with no `-e` (#4479, PR #4514) — the EXIT trap is still there.
3. **The four cycle-aware skills** — no edit is *required* to stay green.
   `plan-epic/scripts/cycle-doc-probe.sh`'s docblock sentence claiming its citation "is what keeps
   the cycle validators scanning a real reference" becomes false on merge and must be corrected to
   name the source edge instead. `review-code/scripts/cycle-doc-probe.sh` may drop its copy.
4. **`.patterns/skill-derived-guards.md`** — its "Sibling-scoped, never the whole plugin tree" bullet
   gains the edge-vs-directory distinction, so the pattern doc and the resolver agree.
5. **Tests** — `kp_skill_shell_surfaces` needs falsification cases: an edge whose target is missing
   resolves UNRESOLVED (red), a comment naming the shared path resolves no edge, and a skill that
   sources nothing keeps exactly today's surface.
6. **Explicitly out of scope** — `packages/pipeline-cli/src/skill-shell-surface.ts` keeps its
   sibling-only scoping for now; whether it adopts the same one-hop rule is a separate call, since
   its consumers are heading-sliced parsers rather than corpus-wide greps.

## Records

- Records the ruling on #4505 (`type:decision`). The three shapes weighed there are answered: (1)
  accepted, (2) and (3) rejected with reasons.
- Vocabulary impact: coins **source-edge surface** — a scan surface widened by a demonstrated source
  edge, as against one defined by directory membership. Routed to `.glossary/LANGUAGE.md` via report
  issue #4529, since this PR touches only `.decisions/`.
- Contradiction sweep run against the 189 live-accepted, uncited ADRs. Its eight-entry shortlist is
  lexical adjacency only — none rules on what a guard's *scan surface* is. The nearest neighbour,
  [0228](0228-scripts-relay-never-derive.md), governs the same #4435 programme but decides what an
  extracted script may compute, not what a guard may read; [0174](0174-bare-sh-guards-control-plane-gate.md)
  and the §CP-classification ADRs decide which files are control-plane, a different question from
  which files a check scans. No supersession or amendment is owed.
- Adjacent, deliberately not decided here: #4510 (shared-lib stdout/stderr contract), #4487
  (`kp_skill_shell_surfaces` discards `find`'s exit status — named as item 1's companion fix, not
  ruled), and the epic #4435 scan-surface class the prose floor belongs to.
