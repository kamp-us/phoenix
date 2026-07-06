---
id: 0164
title: "A guard-relaxing ADR is control-plane (§CP) — the founder ratifies any ADR that cites or amends a documented guard; ship-it classifies a guard-touching .decisions/** file §CP by CONTENT (conservative, fail-closed), not by an author-declared tag"
status: proposed
date: 2026-07-06
tags: [pipeline, ship-it, control-plane, governance, security, gates]
---

# 0164 — Guard-relaxing ADRs are §CP: the founder ratifies a guard amendment; ship-it holds a guard-touching ADR by a conservative, content-inferred predicate

## Context

An ADR under `.decisions/**` is **doc-class**: `review-doc` verifies it, and on a
`review-doc: PASS` `ship-it` **auto-merges** it — `.decisions/**` is explicitly *non*-blocking
in the control-plane set ([`gh-issue-intake-formats.md §CP`](../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md),
"Everything else — … `.decisions/**` … — is non-blocking and auto-merges through its matching
gate on a PASS"). The canonical §CP matcher is a **path** regex; it does not — and structurally
cannot, by path alone — distinguish a guard-relaxing ADR from an ordinary one.

**The hole (proven live).** When an ADR *relaxes, amends, or widens an exemption on* a documented
guard, there is **no mechanical human-gate** holding it for ratification. The only thing that held
the in-flight containment-exemption ADRs (0161/0162, which relax ADR 0083's containment guard) was **agent
discipline** — the EM hand-holding the bank (a cansirin wait + a watcher). A stray shipper, or a
mid-flight-on-green compaction that resumed at the enqueue step, would auto-merge a guard-weakening
ADR past any founder ratification. That is a **fail-open in the control plane**: the pipeline
auto-shipping a weakening of its own guardrails is exactly the class §CP exists to prevent (ADRs
[0053](0053-control-plane-boundary.md)/[0065](0065-gate-critical-skills-are-blocking.md)), and
guard/invariant relaxation is the **author ≠ approver** class that must keep a human in the loop
(ADR [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md); the
invariant-removal-needs-adversarial-review rationale).

This is engineering-led control-plane hardening (ADR
[0078](0078-product-driven-decisions-by-default.md): the pipeline/gate substrate is the
engineering lane), so there is **no founder prose-ratification gate on *this* ADR's authoring** —
but its *subject* is precisely a founder-ratification gate on a future class of ADRs.

## Decision

### POLICY — the founder ratifies any guard-relaxing ADR

An ADR that **relaxes, amends, widens an exemption on, or drops** a documented guard/invariant
must be **ratified by the founder** before it merges. "Discipline holds the line" is fragile by
construction — it holds until the first agent that lacks the norm, then silently ships a weakened
gate. The gate must be **mechanical**, not a norm.

### MECHANISM — conservative, content-inferred §CP classification (NOT an author-declared tag)

The signal carrier is the load-bearing fork, and it is resolved **against** the tempting
author-declared marker:

- **Rejected: an author-declared frontmatter tag** (`relaxes:` / `guard-change` / `status:
  needs-ratification`). It is **self-defeating**: the same agent that lacks the discipline to hold
  a guard-relaxing ADR also lacks the discipline to *add the tag* — so the detection re-opens the
  exact failure mode it closes. An author-declared signal is a norm wearing a mechanism's clothes.

- **Chosen: a conservative, fail-closed CONTENT predicate.** `ship-it`'s Step-0 §CP classification
  inspects the **content** of every touched `.decisions/**` file. If the ADR **cites or amends a
  documented guard** — i.e. its prose names any guard/invariant/enforcement concept (or a
  relaxation verb over one) — it classifies **§CP**: human-merge, held for founder ratification.
  This is deliberately **over-inclusive**: an ADR that merely *cites* a guard without relaxing it
  is still routed to a human approval, which is **cheap** (a fast approve), whereas a missed
  guard-relaxer auto-ships a weakened gate, which is the bug. The design bias is flipped to
  **"default §CP on any guard mention, auto-ship only on positive evidence the ADR is guard-free"**
  — the same fail-closed stance as ADR
  [0092](0092-gates-fail-closed-on-zero-scope.md). "You cannot relax a guard without naming it," so
  a content probe over guard vocabulary catches the class that an author tag would let slip.

**Why content-inference beats detecting "relaxes" precisely.** Whether an ADR *relaxes* a guard is
a judgment call, not a mechanizable predicate — that is why this was filed `type:decision`. So the
mechanism does **not** try to detect relaxation; it detects the strictly broader, mechanically
decidable "**touches guard territory**" and routes the whole class to a human. Precision is traded
for a fail-closed over-match, on purpose.

### Enforcement seam — `ship-it` Step 0, single-sourced in §CP, drift-locked

- The predicate lives as **one canonical definition** — `GUARD_ADR_RE`, the guard-vocabulary
  regex — in [`gh-issue-intake-formats.md §CP`](../claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md),
  beside `CONTROL_PLANE_RE`. It is **not** a hard-coded copy: `ship-it` Step 0 carries only a
  fail-closed reference literal and **re-resolves the live value from `origin/main` at run time**
  (REST raw, `?ref=main`), exactly as it already does for `CONTROL_PLANE_RE` (#981) — so a stale
  injected snapshot cannot mis-classify. `validate-gate-path-drift.sh` gains an invariant locking
  `ship-it`'s copy byte-identical to the §CP canonical, mirroring the `CONTROL_PLANE_RE` lock (ADR
  [0073](0073-review-skill-gate.md) §6). This respects the §CP single-source discipline (one
  predicate, drift-locked; no reintroduced hard-coded copy).

- The classification is **fail-closed end to end**: if the boundary read from `origin/main` fails,
  the predicate degrades to "match everything" (every touched ADR is §CP); if any individual ADR's
  content cannot be read at the PR head (a delete, a 404), that ADR is treated as §CP. The gate
  never auto-ships an ADR it could not read and prove guard-free.

- On a match, `ship-it` classifies the PR **§CP: APPROVAL-GATED** and **STOPS at `awaiting
  control-plane approval`** absent a current-head `@kamp-us/control-plane` team approval — the
  identical hold ADR 0135 already applies to path-§CP PRs. **No new approver system is
  introduced**: the mechanical gate reuses the existing §CP control-plane approval. Per the POLICY,
  the approving control-plane member for a guard-relaxer should be the **founder** (author ≠
  approver, ADR 0135), not merely any control-plane merger.

### Routing is unchanged — only merge-authority moves

`review-doc` still **verifies** a guard-touching ADR (its verdict routing is orthogonal to
merge-authority — the §CP set governs *who merges*, not *which gate verifies*; §CP). The content
predicate adds the §CP **merge-authority hold** in `ship-it` only; `review-doc` is deliberately
left unchanged. A guard-touching ADR therefore still earns a `review-doc` PASS, and `ship-it` then
consumes that PASS **plus** the control-plane approval before enqueue.

## Adversarial self-check (the classification boundary)

- **(a) Author-tag evasion — closed by construction.** There is no author tag to omit; the signal
  is inferred from prose. Evading it requires relaxing a guard while naming *no* guard/invariant/
  enforcement concept — which is nearly impossible, since relaxing a guard requires citing it.
  **Residual gap:** an ADR could reference a guard purely obliquely ("makes the check in ADR 0083
  advisory") using no vocabulary in the regex. Mitigation: the regex is broad and **extensible**,
  and the fail-closed default plus the path-§CP net (an ADR that also edits a §CP file is caught by
  `CONTROL_PLANE_RE`) reduce the exposure; a missed synonym is a regex extension, not a redesign.

- **(b) A guard-cite the pattern misses → default toward §CP.** The predicate over-matches on
  purpose (guard-concept vocabulary *or* a relaxation verb), and the boundary/content reads are
  fail-closed, so an unreadable or ambiguous ADR classifies §CP. The failure direction is toward
  human approval, never toward auto-ship.

- **(c) An exempt-class false-negative — none introduced.** The change only *adds* §CP coverage to
  a subset of `.decisions/**`; it removes coverage from nothing. The path §CP set is untouched, so
  no previously-blocking class is freed. A mixed PR that buries a guard-relaxing ADR among many
  files is caught because the probe scans **every** touched `.decisions/**` file (paginated), and a
  single match blocks the whole PR.

## Consequences

- A guard-relaxing ADR can no longer auto-ship on a `review-doc` PASS; it is held for a
  control-plane (founder) approval — the guard now holds the guard-relaxation, not an agent's
  memory.
- Some guard-*mentioning* but non-relaxing ADRs will also require a control-plane approval. This is
  an accepted, cheap over-match (a fast approve) traded for the fail-closed guarantee; it is not a
  bug to "optimize away" by narrowing toward author-declared detection.
- The predicate's vocabulary is a living list; extending it (per residual gap (a)) is itself a §CP
  change to `gh-issue-intake-formats.md`.

## Alternatives considered

- **Author-declared frontmatter tag** — rejected as self-defeating (see MECHANISM).
- **A new "founder-only" approver mechanism** — rejected as needless surface; the §CP control-plane
  approval (ADR 0135) already provides the human hold, and the POLICY names the founder as the
  expected approver within it.
- **Teaching `review-doc` to detect guard-relaxation and withhold its PASS** — rejected: the
  verdict axis is orthogonal to merge-authority (§CP), and putting the hold in the merge authority
  (`ship-it`) keeps the single choke point where merge decisions already live (ADR
  [0048](0048-ship-it-merge-actor.md)).

## References

- ADRs [0053](0053-control-plane-boundary.md)/[0065](0065-gate-critical-skills-are-blocking.md) — the control-plane boundary + gate-critical-skills widening.
- ADR [0078](0078-product-driven-decisions-by-default.md) — engineering leads on platform/pipeline (this ADR's lane).
- ADR [0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md) — approval-aware §CP enqueue (the reused hold) + author ≠ approver.
- ADR [0073](0073-review-skill-gate.md) §6 — the §CP single-source + drift-lock discipline.
- ADR [0092](0092-gates-fail-closed-on-zero-scope.md) — fail-closed on zero scope (the stance this predicate adopts).
- ADR [0048](0048-ship-it-merge-actor.md) — ship-it as the single merge authority (where the hold belongs).
