---
id: 0212
title: the root marketplace manifest (.claude-plugin/) is §CP — the file governing control-plane delivery is itself control plane
status: accepted
date: 2026-07-25
tags: [pipeline, control-plane, ship-it, marketplace, plugin, classifier]
---

# 0212 — the root marketplace manifest is control-plane

## Context

The control-plane boundary (ADR [0053](0053-control-plane-boundary.md), enforced at GitHub per
ADR [0071](0071-enforce-control-plane-at-github.md), hard-gated per ADR
[0135](0135-hard-gate-control-plane-team-codeowners-approve-then-enqueue.md)) marks the surfaces
where an autonomous green-then-ship merge could compromise the pipeline's own guards. The concrete
boundary is the single-source path regex in
`packages/pipeline-cli/src/tools/control-plane-paths/control-plane-re.ts`,
its byte-synced `CONTROL_PLANE_RE=` copy in
`gh-issue-intake-formats.md`,
and `.github/CODEOWNERS`.

`.claude-plugin/marketplace.json` is the manifest declaring what the `kampus` marketplace serves —
including `kampus-pipeline`, the plugin that ships the gate-critical skills (`ship-it`,
`review-code`, `review-doc`, `review-skill`, `review-plan`, `review-trivial`, `triage`,
`write-code`, `plan-epic`, `release`) and the pipeline agent definitions. Each entry names a
`source` tree; that field is not decorative — `validate-gate-path-drift.sh` Invariant 2 resolves
the `.claude/skills` symlink *against* it, precisely because "both express the same plugin root;
divergence means the harness loads skills from a different tree than the one the marketplace
advertises."

**The file was outside §CP on both enforcement surfaces**, verified against the live boundary:

- **`CONTROL_PLANE_RE`** — the relevant branch is `^(\.claude|\.github)/`, which requires a
  literal `/` immediately after `.claude`. The character after `.claude` in `.claude-plugin/` is a
  **hyphen**, so the branch never matched, and no other branch covers it (the `claude-plugins`
  branches are all scoped under `claude-plugins/kampus-pipeline/`). Re-checked mechanically
  against the live regex: `.claude/settings.json` matches, `.claude-plugin/marketplace.json` does
  not.
- **`.github/CODEOWNERS`** — the row is `/.claude/` (trailing slash); no `.claude-plugin` row, so
  `require_code_owner_review` did not bind either. (The drift gate agreed with itself: with no §CP
  branch there was no path for `codeowners-cp` to demand a row for.)

The consequence, observed live on PR #3919: a PR that registers a plugin in the marketplace
manifest classified as non-§CP with zero path matches and would auto-ship on green, while a
one-line docstring change under `packages/pipeline-cli/**` requires a human control-plane
approver. The delivery channel for the gates was less protected than a comment inside them.

ADR [0187](0187-crew-mcp-is-not-control-plane.md) fixed the §CP discriminator as an
**enforcement-surface test**: a path is §CP if merging it unreviewed could weaken the pipeline's
enforcement of its own rules — not because it is merely pipeline-adjacent. The marketplace
manifest passes that test one step removed but decisively: it does not *contain* a guard, it
**decides which tree the guards are loaded from**. An unreviewed edit to `source` redirects
delivery of the entire enforcement corpus, which is strictly stronger than weakening any single
guard inside it.

Tracked as #3933 (filed `type:decision` — the deliverable is a recorded ruling either way). The
issue's anti-self-authorization criterion (#981) — "the regex is not widened ahead of the ruling" —
is satisfied **structurally**, not by promise: the PR carrying this ADR edits `CONTROL_PLANE_RE`'s
single source, `packages/pipeline-cli/**`, and `.github/CODEOWNERS`, so it is §CP under the
**current** boundary and cannot merge without a non-author control-plane approval. That approval
*is* the ruling; the widening lands only with it.

## Decision

`.claude-plugin/**` — the repo-root marketplace manifest directory — is **§CP**. Both mechanisms
cover it:

- **`CONTROL_PLANE_RE`** gains its **own** anchored branch, `^\.claude-plugin/`. It cannot be
  folded into `^(\.claude|\.github)/`: that branch's `/` is what excluded the hyphenated dir in
  the first place. Widening it to a bare `^\.claude` prefix is **rejected** — that would capture
  both directories implicitly and leave the boundary illegible.
- **`.github/CODEOWNERS`** gains `/.claude-plugin/ @kamp-us/control-plane`, the merge-time teeth.
  The existing `/.claude/` row does **not** cover it (a directory pattern covers only paths under
  itself), so the row is load-bearing, not decorative.

The branch is **directory-scoped, not `marketplace.json`-scoped**. `.claude-plugin/` is the
manifest directory by the marketplace convention; every file in it is plugin-delivery metadata by
construction, and a file-anchored branch would be routed around by a rename or a companion
manifest. Today the directory holds exactly one tracked file, so the widening admits exactly one
path: `.claude-plugin/marketplace.json`.

The branch is **root-anchored**, deliberately. An un-anchored form (`(^|/)\.claude-plugin/`) would
also capture every nested plugin's `plugin.json`, including `claude-plugins/pipeline-crew/`, whose
corpus a live founder ruling re-affirmed 2026-07-24 keeps **out** of §CP (#3765). Anchoring keeps
this decision from silently reversing that one.

## Consequences

- A PR touching `.claude-plugin/**` no longer auto-ships on green; it banks for a human §CP merge,
  where a second human confirms it does not redirect what the control plane delivers.
- **Exactly one path newly becomes §CP**: `.claude-plugin/marketplace.json`. Nothing else moves —
  every prior branch is unchanged, and the classifier tests assert the known non-matches still do
  not match (`packages/pipeline-crew-mcp/**` per ADR 0187, `.patterns/**`, `.decisions/**`,
  `.glossary/**`, `ROADMAP.md`, `turbo.json`, and the nested `claude-plugins/*/.claude-plugin/`
  manifests).
- **Two sibling gaps stay open, deliberately, and are not closed here** — closing them by widening
  an anchor without a ruling is the exact anti-pattern #981 guards:
  - `claude-plugins/kampus-pipeline/.claude-plugin/plugin.json` — the pipeline plugin's own
    manifest, which declares the components it ships. Same shape as this gap, different path. It is
    deferred for **scope**, not because it is unreachable: a fully-qualified branch
    (`^claude-plugins/kampus-pipeline/\.claude-plugin/`) would reach that manifest alone and
    nothing under `pipeline-crew`, so closing the gap is a scoping decision, not a technical
    problem. #3933 asks exactly one question, and widening past the ruling being sought is the
    anti-pattern #981 guards. Tracked at #4056.
  - `claude-plugins/<plugin>/**` for any plugin other than `kampus-pipeline` — a whole new plugin
    directory matches nothing today (raised on #3933). Unlike the sibling above, this one does
    re-open the #3765 ruling, since it asks whether a third-party plugin corpus is control plane.
    Tracked at #4056.
  - The same shape is on the record for `lefthook.yml` hook-wiring config (#3402 / #3643).
- This ADR governs *who merges*, not *which gate verifies*: routing is a separate axis and is
  untouched.

> Amendment 2026-08-19: the ruling still binds — `/.claude-plugin/ @kamp-us/control-plane` is live in `.github/CODEOWNERS` and the `^\.claude-plugin/` branch now lives at [`packages/fabrika-cli/src/guard/control-plane-re.ts`](../packages/fabrika-cli/src/guard/control-plane-re.ts) (pinned by `control-plane-re.pin.test.ts`), not `packages/pipeline-cli/`. The `kampus-pipeline` clauses are history only: the plugin is deleted (ADR [0303](0303-retire-kampus-pipeline-plugin.md)) and its marketplace entry survives sha-pinned, so the deferred `claude-plugins/kampus-pipeline/.claude-plugin/plugin.json` gap is moot; fabrika is the one pipeline.
