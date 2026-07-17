---
id: 0193
title: lint/GritQL governance config (biome.jsonc + biome-plugins/) is §CP — an ungated path to weaken a lint rule is a guard-relaxing vector
status: accepted
date: 2026-07-16
tags: [pipeline, control-plane, ship-it, lint, gritql, classifier]
---

# 0193 — lint/GritQL governance config is control-plane

## Context

The control-plane boundary (ADR [0053](0053-control-plane-boundary.md), enforced at GitHub
per ADR [0071](0071-enforce-control-plane-at-github.md)) marks the surfaces where an
autonomous green-then-ship merge could compromise the pipeline's own guards, so those PRs
bank for a human control-plane (§CP) merge instead of auto-shipping. The concrete boundary
is the single-source path regex in
[`packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts`](../packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts),
its byte-synced `CONTROL_PLANE_RE=` copy in `gh-issue-intake-formats.md`,
`.github/CODEOWNERS`, and the classifier tests.

The repo enforces code invariants through two lint surfaces: `biome.jsonc` (the biome
config — which rules run, at what severity) and `biome-plugins/*.grit` (the GritQL plugin
rules — e.g. `no-raw-try-catch`, `no-type-assertions`, `no-data-taggederror`). These are
**guards**: they mechanically block classes of unsafe code. Until now those two paths were
outside §CP, so a PR that **weakened** one — disabling a security lint, downgrading a rule
to a warning, deleting or neutering a GritQL rule — could auto-ship on green without any
human control-plane sign-off. That is an ungated path to relax a guard.

ADR [0187](0187-crew-mcp-is-not-control-plane.md) fixed the §CP discriminator as an
**enforcement-surface test**: a path is §CP if merging it unreviewed could weaken the
pipeline's enforcement of its own rules — not because it is merely pipeline-adjacent. The
lint/GritQL governance config passes that test directly: the lint rules *are* enforcement,
and an unreviewed edit that loosens them weakens a gate. This is the sibling scope decision
to 0187 — same principle, opposite direction (0187 narrowed the boundary by one over-broad
clause; this widens it by one genuine enforcement surface).

The founder ruled directly this session (2026-07-16, ruling B): the lint/GritQL governance
config must be §CP, because an ungated path to weaken a lint rule is a guard-relaxing
vector, exactly what the control plane exists to gate. This is a conversation-authored ADR
(ADR [0075](0075-issueless-doc-pr-merge-seam.md)): it is the durable corroboration of that
ruling, not a report→triage item. Ruling-driven, so there is no `Fixes #N` tracking issue.

## Decision

`biome.jsonc` (the repo-root file) and `biome-plugins/` (the GritQL plugin dir, all
`*.grit`) are **§CP**. Both §CP mechanisms now cover them:

- **The `CONTROL_PLANE_RE` classifier** (ship-it's soft gate) gains two anchored branches:
  `^biome\.jsonc$` (the exact root file, end-anchored so a look-alike suffix like
  `biome.jsonc.bak` stays out) and `^biome-plugins/` (the dir prefix, covering every
  `*.grit` rule at any depth). Synced across the single-source const, the byte-equal
  formats-doc copy, and the classifier tests.
- **`.github/CODEOWNERS`** (the GitHub-enforced teeth) gains `/biome.jsonc` and
  `/biome-plugins/`, both routed to `@kamp-us/control-plane`, so
  `require_code_owner_review` hard-blocks a biome-governance edit at merge time without
  control-plane approval. The classifier is ship-it's soft gate; CODEOWNERS is the
  merge-time teeth — a biome-governance PR needs both to pass.

## Consequences

- A PR touching `biome.jsonc` or any `biome-plugins/*.grit` rule no longer auto-ships on
  green; it banks at the §CP human-merge approver, where a second human confirms the change
  does not silently relax a guard.
- The §CP↔CODEOWNERS drift gate (`codeowners-cp`) and `validate-gate-path-drift.sh` both
  keep the two new branches in lockstep with their CODEOWNERS rows; the classifier unit
  tests assert `biome.jsonc` → §CP, `biome-plugins/*.grit` → §CP, and a negative
  (`turbo.json` / `pnpm-workspace.yaml` / `biome.jsonc.bak` stay non-§CP).
- This narrows nothing elsewhere — every prior §CP clause is unchanged; the boundary widens
  by exactly the biome-governance surface. Future authors extending §CP apply ADR 0187's
  enforcement-surface test: a path is §CP when an unreviewed merge of it could weaken a gate.
- Note: routing (which reviewer gate verifies) is a separate axis — `class-probe` already
  classifies these paths as `has-code` (review-code-routed). This ADR governs *who merges*
  (§CP human-merge), not *which gate verifies*.
