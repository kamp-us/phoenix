---
id: 0063
title: "`skills/**` is code-gated — ship-it's doc-probe excludes it, review-code is its canonical gate"
status: accepted
date: 2026-06-15
tags: [pipeline, ship-it, review-code, gate-routing, skills]
---

# 0063 — `skills/**` is code-gated — ship-it's doc-probe excludes it, review-code is its canonical gate

**Amended by [0064](0064-skills-are-control-plane-blocking.md):** `skills/**` are
blocking/manual-merge; this ADR's `review-code` routing is unchanged.

## Context

After #231 moved the issue-intake skills out of `.claude/skills/` to a root `skills/`
directory, a `skills/*.md`-only PR deadlocks the autonomous pipeline.

`ship-it`'s Step 0 class-probe (ADR [0053](0053-control-plane-boundary.md) §4) classes a
file as **docs** when it matches a prose `*.md` *outside* `.claude/`/`.github/`, and as
**code** under `^(apps/web|packages)/`. After the move, every `skills/*/SKILL.md` and
`skills/gh-issue-intake-formats.md` matches the `\.md$` doc-probe — so ship-it reads a
**docs class present** and demands a current-head `review-doc: PASS` (formats §6).

But these PRs are routed to and verified by **`review-code`** — AC-verification against the
issue's acceptance criteria — whose PASS lives in the `review-code` namespace (§5). The two
namespaces are matched by separate anchored regexes that **never cross-match** by design
(ADR 0053 §4.3). So a valid `review-code: PASS` cannot satisfy the `review-doc` requirement:
ship-it resolves the docs namespace to `unverified (no review-doc PASS)` and refuses to merge
— a routing-contract mismatch, not a defect.

This fired live: PR #358 (closed #350) — `review-code: PASS @ b61ad61`, current head, green
CI, run-evidence bundle clean — was refused by ship-it. Any skills-only `*.md` PR (skill-doc
edits, link rewrites, the whole #228 doc-reference work) hits it, defeating the hands-off
`report → … → ship-it` loop and forcing a human to manually re-route through `review-doc`.

The undecided question this ADR settles: **which single canonical gate owns `skills/**`** —
so the gate that runs and the namespace ship-it demands agree, and cannot drift apart again.

## Decision

**`skills/**` is code-gated.** A `skills/**` file belongs to `review-code`'s class, not
`review-doc`'s, and ship-it's Step 0 class-probe **excludes `skills/**` from the doc-probe**
so it never demands a `review-doc` PASS for a skills-only PR.

This is a **blanket** rule over the whole `skills/**` subtree — no path nuance splitting
"behavioral" skill files from "doc-only" skill edits:

1. **Skills are operational/behavioral definitions, not prose docs.** A skill is the
   executable contract an agent runs — `review-plan`, `plan-epic`, `ship-it` itself are
   behavioral logic where `review-code`'s acceptance-criteria gate is the right rigor.
   Even an edit that *looks* doc-shaped (a link rewrite, a wording fix) changes how the
   agent behaves, so AC-verification — "does this still do what the issue says" — fits
   better than `review-doc`'s prose-hygiene checklist.
2. **It matches the working precedent.** PRs #355/#356/#357 (each `skills/*.md`) were
   `review-code`-gated and merged fine; #358's deadlock was the doc-probe disagreeing with
   that established routing, not the routing being wrong.
3. **A blanket rule is the cleaner seam.** A path-nuanced rule (some `skills/**` paths
   doc-gated, others code-gated) would re-introduce exactly the drift this ADR closes:
   two probes that can disagree on a boundary line. One subtree → one gate → one namespace
   is the invariant the deadlock taught us to enforce.

The control-plane boundary is **unchanged**: `.claude/**` and `.github/**` remain BLOCKING
(human merge, ADR 0053). This ADR only reclasses the *non-control-plane* `skills/**`-prose-`.md`
class from docs to code; it does not touch what ship-it refuses to auto-merge.

Concretely, ship-it's Step 0 doc-probe gains a `skills/**` exclusion so the docs-class grep
no longer matches a `skills/**` path:

```bash
echo "$FILES" | grep -Ev '^skills/' | grep -Eq '^(\.decisions|\.patterns)/|\.md$' && echo "has-docs"
```

`review-code`'s class-membership note and the formats §5/§6 contract cite this ADR so the
router and the probe stay pinned to the same choice.

## Consequences

- **The deadlock is closed.** A `skills/*.md`-only PR is classed as code, gated by
  `review-code`, and ship-it demands a `review-code: PASS` (current-head, SHA-bound per ADR
  [0058](0058-sha-bound-verdict-contract.md)) — exactly the namespace the gate writes. It
  ships end-to-end with no manual re-routing.
- **The marker contract is untouched.** The two anchored, never-cross-matching, SHA-bound
  namespaces (§5/§6, ADR 0058) and the ACL author-gate (ADR
  [0055](0055-acl-sourced-review-authz.md)) are preserved verbatim; only *which class a
  `skills/**` path falls in* changed, not how a verdict is matched or trusted.
- **`review-code` gates skill behavior.** A skill edit is now verified the same way product
  code is — against the issue's acceptance criteria — which is the correct rigor for an
  operational definition and stronger than `review-doc`'s prose-hygiene pass.
- **`review-doc`'s domain narrows by one path-class.** `review-doc` keeps `.decisions/**`,
  `.patterns/**`, and prose `*.md` *outside* `.claude/`/`.github/`/`skills/`. A `skills/**`
  `.md` is no longer in its lane.
- **No path nuance to maintain.** The blanket exclusion means there is no boundary line
  inside `skills/**` for a future edit to land on the wrong side of — the seam cannot drift.
- **Relationship:** refines ADR [0053](0053-control-plane-boundary.md) §4's class-probe
  (the docs class now carves out `skills/**`) without weakening its control-plane refusal;
  preserves ADR [0058](0058-sha-bound-verdict-contract.md) (SHA-binding) and ADR
  [0055](0055-acl-sourced-review-authz.md) (ACL author-gate) unchanged. As a `skills/**`
  (non-control-plane) + `.decisions/**` change, this ADR and its ship-it patch are
  themselves `review-code`-gated and ship autonomously — they do **not** touch `.claude/**`
  or `.github/**`, so ADR 0053's manual-merge refusal does not apply to this PR.
