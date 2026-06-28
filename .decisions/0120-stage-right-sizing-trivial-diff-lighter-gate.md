---
id: 0120
title: Right-Size the Pipeline Fan-Out to Diff Complexity — A Trivially-Classified Diff Routes to a Lighter-but-Still-Fail-Closed Gate (Adopt Behind an ADR 0112 Measurement Gate; Bounded in the Spirit of 0070)
status: accepted
date: 2026-06-28
tags: [pipeline, token-economics, write-code, review, fan-out, methodology]
---

# 0120 — Right-Size the Pipeline Fan-Out to Diff Complexity, Bounded and Measurement-Gated

## Context

The executor (`.claude/workflows/drive-issue.js`) drives **one full fan-out per issue**:
a `write-code` agent, then a `review-*` gate, then `ship-it`. That cost is roughly
constant — on the order of ~180k+ combined output tokens — whether the diff is a
one-line doc fix or a 200-line refactor. On a backlog drain where a large share of PRs
are small (doc fixes, one-line stub fixes, comment retires), the fixed per-PR overhead
dominates total spend on exactly the lowest-value work. The worked example that motivated
epic child [#1486](https://github.com/kamp-us/phoenix/issues/1486): #1399 was a
single-line `CLAUDE.md` doc-accuracy fix that still paid a full coder (~63k) +
`review-doc` + shipper fan-out.

This is a candidate lever under epic
[#1356](https://github.com/kamp-us/phoenix/issues/1356) (milestone "Token efficiency —
zero quality compromise"), and it sits squarely under the hard constraint that epic set
and [ADR 0112](0112-token-measurement-no-quality-compromise-methodology.md) recorded:
**no token-saving lever is adopted on a claimed-but-unmeasured saving, and a quality
regression vetoes the lever regardless of the token win.** A one-line change can still be
*wrong*, or leak a secret or a machine-local path — so the decision here is emphatically
**not** "skip the gate for trivial diffs." It is whether a *trivially-classified* diff
may route through a **cheaper-prompt but still fail-closed** verify path instead of the
full fan-out, and if so, how that path stays fail-closed.

The precedent shape already exists. [ADR 0070](0070-investigation-trivial-fix-collapse.md)
(investigation → trivial-fix collapse) is a **bounded** cheaper path gated by a hard AND
of explicit checks that skips *ceremony* without skipping the `review-code` *gate*. A
right-sized fan-out is the analogous lever: a bounded trivial-diff path whose bound is
exactly what keeps the lighter gate fail-closed.

## Options considered

### (a) Status quo — one full fan-out per PR, regardless of diff size

Keep paying the full `write-code → review-* → ship-it` fan-out for every PR.

- **For:** Zero new rules; one uniform path; the gate's strength is never in question.
- **Against:** Pays the worst token-per-value ratio on the most common drain PRs (the
  small ones). The fixed overhead dominates spend on the cheapest work — the exact waste
  #1486 names.

### (b) Skip the gate for trivial diffs (auto-merge a small diff)

Classify a diff as trivial and merge it without a review gate at all.

- **For:** Maximal token saving — the gate cost goes to zero.
- **Against:** **Rejected — it breaks the ADR 0112 no-quality-compromise bar.** A
  one-line change can be wrong or leak a secret / a machine-local path; an ungated trivial
  path has no fail-closed catch for that. Skipping the gate is not right-sizing, it is
  removing the safety property the pipeline exists to provide.

### (c) Right-size the fan-out — a trivially-classified diff routes to a lighter-but-still-fail-closed gate

A deterministic, fail-closed classifier marks a diff "trivial"; a trivial diff routes
through a **reduced-prompt** verify that is **still an independent fail-closed gate** —
only the gate's *prompt cost* is reduced, the gate is not skipped. A diff that fails
**any** classifier bound falls back to the full fan-out. Adoption is gated on an ADR 0112
measurement (token delta + held gate-accuracy on the frozen set).

- **For:** Captures the saving on the common small-PR case **without** removing the gate —
  the lighter path still catches a bad trivial change. Models the proven ADR 0070 shape
  (bounded cheaper path, gate not skipped). Stays honest about savings: the win is
  *measured* before it is *adopted*, per ADR 0112.
- **Against:** Introduces a classification judgement and a second path. Mitigated by making
  the classifier **mechanical and fail-closed** (a hard AND of checks, never a vibe) and by
  routing every miss to the full path.

## Decision

**Adopt (c): right-size the fan-out to diff complexity — behind an ADR 0112 measurement
gate.** This ADR records the decision and its mechanism; the implementation is deferred to
a filed follow-up (see *Consequences*), exactly as ADR 0070 deferred its skill edits to
#389 and ADR 0114 deferred to #1389. Four parts:

### 1. What makes a diff "trivially-classified" — a deterministic, fail-closed bound

A diff is trivial **only if it clears every bound below** (a hard AND, in the spirit of
ADR 0070's four bounds). The predicate is mechanical — computed from the diff and the
live boundary, never a taste call:

1. **Small and single-concern.** The change is one logical concern in a small, reviewable
   diff — doc/comment-only, **or** a single file under a fixed line bound `N` (the concrete
   `N` is set and justified at implementation time on the measured set, not guessed here).
2. **No code-path change / no new surface.** No new public API, route, config key, binding,
   schema/migration, or dependency; no change to executable control flow. The change
   corrects or clarifies *existing* prose or an existing trivial line.
3. **Not control-plane.** The diff must AND against the **live** `CONTROL_PLANE_RE` (§CP of
   `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md`), **re-resolved from
   `origin/main` at run time** — never a stale snapshot (the #981 mis-classification class).
   Any control-plane path (`.claude/**`, `.github/**`, a gate-critical skill, the
   enforcement-guard packages) is **never** trivial; it takes the full path and a human
   merge (ADR [0053](0053-control-plane-boundary.md) /
   [0065](0065-gate-critical-skills-are-blocking.md) /
   [0100](0100-control-plane-covers-enforcement-guard-packages.md)).

### 2. The lighter path is a *reduced gate*, not a skipped gate

A trivial diff routes through a **cheaper-prompt** verify that is **still an independent,
fail-closed gate** — it must still catch a wrong one-liner, a leaked secret, and a leaked
machine-local / home / absolute / sibling-repo path. Only the gate's *prompt cost* is
reduced (a tighter, scoped checklist over a small diff), never its authority to FAIL.
Split-role review is preserved: the lighter gate is run by an **independent** reviewer, not
by the author (the write-code firewall is unchanged).

### 3. How it stays fail-closed — default-deny, fall back to the full path

The classifier is **fail-closed by construction**: a diff is trivial only on a positive,
all-bounds-clear result. Any of — a failed bound, a classifier error, an unreadable live
`CONTROL_PLANE_RE`, or any ambiguity — routes the diff to the **full fan-out**. A
misclassified non-trivial diff therefore **under-gates never**; the worst case of a
classifier miss is paying the full (correct) cost, not shipping under a lighter gate. This
mirrors the gates' existing `CONTROL_PLANE_RE='.'` fail-closed posture (flag everything
when the boundary can't be read).

### 4. Adoption is gated on a measurement — ADR 0112, both axes, the quality veto

The lighter path is **not** flipped on by recording this decision. Adoption is gated, per
ADR 0112, on a measurement on the frozen task set
([`.patterns/token-economics-measurement.md`](../.patterns/token-economics-measurement.md)),
**both axes holding simultaneously**:

- **Token axis** — a real, measured token-per-PR reduction for the trivial path vs the full
  fan-out, against the recorded baseline, via the `spawn-guard`-grounded procedure.
- **Quality axis (the veto)** — measured **gate-accuracy** on the frozen set showing the
  lighter gate still catches a bad trivial change (a wrong 1-liner, a leaked secret/path).
  A quality regression **vetoes the lever** regardless of the token saving.

**This ADR claims no number.** Per ADR 0112's division of surfaces, the measured
token-per-PR delta and gate-accuracy result live on the implementation child, not here, so
this record does not go stale as the measured numbers are taken and refreshed.

## Consequences

- **The common small-PR case can stop paying the full fan-out — once measured.** The lever
  targets exactly the poor-token-per-value work #1486 names, and it does so without removing
  the gate: the saving is captured at the gate's *prompt cost*, not at its *authority*.
- **The exception cannot be stretched.** The bounds are mechanical and AND-ed (small /
  no-surface / not-control-plane against the live boundary); anything that fails a bound —
  a multi-file change, a new surface, a control-plane edit, an unreadable boundary — falls
  back to the full path automatically. "Trivial" is computed, not felt.
- **Fail-closed is structural, not advisory.** Default-deny routing means a classifier miss
  costs tokens (the full path), never quality (an under-gated merge). The split-role firewall
  and the SHA-bound verdict contract are untouched — the lighter gate is still an independent
  reviewer's fail-closed verdict.
- **No adoption on an unmeasured saving.** This decision authorizes the *mechanism*; the
  ADR 0112 measurement on both axes is the gate that authorizes the *flip*. A token win that
  buys a quality regression is a fail, not a win.
- **Implementation is follow-up work.** This ADR records the decision; the build — the
  deterministic classifier, the lighter gate path, the fail-closed fallback wiring in
  `.claude/workflows/drive-issue.js` / the fan-out skills, and the gating measurement —
  touches gate-critical control-plane surfaces (ADR 0065) and is tracked in
  [#1527](https://github.com/kamp-us/phoenix/issues/1527) (`status:needs-triage`). That
  implementation PR therefore takes the full path + a human merge, unlike this ADR-only
  (`.decisions/**`) PR.
- **Relationship.** This ADR **composes with** ADR 0070 (it is the analogous bounded-cheaper-path
  lever, applied to the per-PR fan-out rather than the investigation-residue intake) and is
  **governed by** ADR 0112 (its adoption gate). Bound #3 explicitly defers to ADR
  0053/0065/0100's control-plane boundary, so a control-plane change is never trivial.
