---
id: 0221
title: "Pipeline Anywhere GA: two tiers, staged gates, hybrid guard surface"
status: superseded by [0303](0303-retire-kampus-pipeline-plugin.md)
superseded_by: 0303
date: 2026-07-26
tags: [pipeline, distribution, workflows, guards, ga]
---

# 0221 — Pipeline Anywhere GA: two tiers, staged gates, hybrid guard surface

**What this decides:** what "done" means for Pipeline Anywhere (the pipeline running on
repos other than phoenix): it ships to two named customer tiers (same-org and outside
adopter), GA is declared by four checkable staged gates instead of milestone closure,
guards install as an individually selectable menu whose prerequisites doctor enforces
per selected guard, and every reusable workflow pins its own compatible CLI version.

## Context

The pipeline is a product with external consumers, deliberately homed in phoenix as a
tenant (ADR [0201](0201-pipeline-tenant-phoenix-first.md)). Two of its three channels
are validated live: the second operator's private repo already consumes the marketplace
plugin (autoUpdate) plus the pinned-dlx CLI with nothing vendored (#4333) — the ADR
[0062](0062-repo-as-config-plugin.md) repo-as-config channel works outside phoenix
today. The unbuilt channel is workflows: phoenix's CI guards run as phoenix-local
workflow files, not reusable workflows an adopter can call by reference.

Ruled by the founder 2026-07-26 in a wayfinder session on map #4319; frontier tickets
#4320–#4325 and #4333 hold the full frames. The forcing constraint is source-grounded:
GitHub's `secrets: inherit` only crosses repos within the same org/enterprise, so one
unmodified reusable workflow cannot serve both a kamp-us caller and an outside adopter.

## Decision

**Pipeline Anywhere ships to two named customer tiers; GA is four staged checkable
gates; guards are a selectable menu with per-guard prerequisite bands enforced by
doctor; and each reusable workflow pins its own compatible CLI version.**

1. **Two-tier customer model (founder, #4321).** Both tiers are declared deliverables:
   - **Tier 1 — same-org (kamp-us):** repos call phoenix's reusable workflows by
     reference with inherited secrets (`secrets: inherit`).
   - **Tier 2 — outside adopter:** explicit-secrets inputs plus config seams. The named
     tier-2 dogfood bed is a founder-owned personal-account repo outside the kamp-us
     org — deliberately the hard, GA-shaped path.

   The split is forced, not chosen: `secrets: inherit` stops at the org/enterprise
   boundary, so no single unmodified product serves both.

2. **Staged GA acceptance test (founder, #4320).** Four checkable gates replace
   milestone-closure-as-proxy (answers #4268):
   1. **Mechanism beta** — a kamp-us repo consumes the first reusable workflow by
      reference.
   2. **RC** — the tier-2 bed runs one issue → triaged → PR → merged, end to end.
   3. **GA** — the existing second operator completes the loop on their own private
      repo operation-unassisted.
   4. **Post-GA gate** (named, not GA-blocking) — a fresh-bootstrap proof via
      doctor/seeder/docs alone.

   GA additionally requires a Diátaxis-quadrant adopter tutorial, authored with the
   plugin's own `diataxis` skill and gated through `review-doc`, slotted between RC
   and GA.

3. **Hybrid guard surface (founder, #4322).** Guards are individually selectable (menu
   DX); every guard declares its prerequisite band from the observed ladder:
   - **tier 0** — plugins + CLI (no repo asserts beyond `gh` auth);
   - **tier 1** — zero-assumption file-scanner guards;
   - **tier 2** — process guards (label taxonomy + ROADMAP + milestone-homing);
   - **tier 3** — control plane (boundary artifact, approver team, CODEOWNERS, merge
     queue).

   Doctor/preflight enforces prerequisites per selected guard, not globally. Default
   install = tier 0. Rationale: a flat menu hides prerequisites until they fail (the
   vacuous-pass class, ADR [0092](0092-gates-fail-closed-on-zero-scope.md)); pure tiers
   force false coupling; prerequisites are facts, selection is preference.

4. **Workflow↔CLI compat contract (engineering-led per ADR
   [0078](0078-product-driven-decisions-by-default.md), #4325).** Each reusable
   workflow carries its own default CLI version (`pnpm dlx @kampus/pipeline-cli@<pin>`),
   guard-locked equal to the single pin home
   (`claude-plugins/kampus-pipeline/hooks/pin.sh`) — so an adopter's `@<ref>`
   content-addresses workflow + pin together, mirroring the plugin/pin pairing of ADR
   [0110](0110-plugin-carries-no-version-continuous-ship.md). "No contract" is
   falsified by the #3742 incident (the CLI, ADR
   [0103](0103-consolidate-pipeline-cli-package.md), fails closed on zero scope, not on
   version drift). A build-time refinement — a called workflow sourcing `pin.sh` via
   its own SHA — is noted on #4325.

**Binding constraints.**
- Both tiers are deliverables; neither GA-gates the other away.
- GA is declared by the staged gates alone — never by milestone closure.
- Every guard declares its prerequisite band; doctor enforces per selected guard.
- Every reusable workflow's default CLI version is guard-locked to the one pin home.

**Banned.**
- One unmodified workflow product claiming to serve both tiers (falsified by the
  `secrets: inherit` boundary).
- A globally enforced tier prerequisite (per-guard enforcement only).
- Declaring GA while gate 3 (second operator, own private repo, unassisted) is unmet.

## Consequences

- The workflow channel gets built tier-1-first (mechanism beta), then hardened against
  the tier-2 bed before GA — the hard path is dogfooded, not deferred.
- Doctor grows per-guard prerequisite checks; the guard menu becomes the install DX.
- The compat guard extends the existing pin-lock surface: workflow-carried CLI pins
  red the build when they drift from `hooks/pin.sh`.
- The GA definition is auditable: each gate is a checkable event, so "are we GA?" has
  a yes/no answer without re-litigating scope.
- Fresh-bootstrap (gate 4) is explicitly post-GA: GA does not wait on seeder/docs
  perfection, but the gap stays named instead of silently dropped.

## Records

- Emitted execution epics: #4340–#4344. Frames: map #4319, tickets #4320–#4325, #4333.
- Vocabulary impact: coins **Pipeline Anywhere** (with its tier vocabulary — tier
  1 same-org / tier 2 outside adopter customer tiers, and the tier 0–3 guard
  prerequisite bands); routed to `.glossary/TERMS.md` in this PR.
