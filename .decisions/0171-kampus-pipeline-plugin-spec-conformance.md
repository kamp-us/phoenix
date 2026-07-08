---
id: 0171
title: kampus-pipeline is audited spec-conformant against the official Claude Code plugin spec — the `$schema` URL is corrected, every remaining shape is a documented-intentional deviation
status: accepted
date: 2026-07-07
tags: [plugin-portability, packaging, distribution, pipeline]
---

# 0171 — kampus-pipeline is audited spec-conformant against the official Claude Code plugin spec

## Context

`claude-plugins/kampus-pipeline/` was assembled incrementally (ADRs 0062, 0087, 0103,
0110, 0150) and had **never been audited end-to-end against the official Claude Code
plugin spec**. The sibling `pipeline-crew` plugin (epic #2342) is built next and must land
on a *normalized, uniform* shape from day one — so any structural drift the first plugin
carries would be copied into the second. This ADR is the Phase-1 gate (#2346): a
one-pass conformance audit of the plugin manifest, the hooks reference, the `agents/` /
`skills/` layout, the `commands/` absence, the `.claude/skills` discovery symlink, and the
repo-root marketplace catalog entry — fixing genuine drift and recording every deliberate
deviation so a future audit reads "documented intentional," not "open defect to re-file"
(the same recurrence-immunization ADR 0110 exists for).

The audit is grounded in the official documentation, not intuition (the repo's
grounding convention):

- Plugins reference — <https://docs.claude.com/en/docs/claude-code/plugins-reference>
- Create plugins — <https://docs.claude.com/en/docs/claude-code/plugins>
- Plugin marketplaces — <https://docs.claude.com/en/docs/claude-code/plugin-marketplaces>

## Decision

**One drift is fixed; everything else is affirmed spec-conformant, with each deviation a
documented-intentional choice.**

### Fixed drift — the manifest `$schema` URL

`plugin.json` declared `"$schema": "https://json.schemastore.org/claude-code-plugin.json"`,
which **404s** — that schema does not exist. The canonical value the plugins reference
documents (its `$schema` metadata-field row) is
`https://json.schemastore.org/claude-code-plugin-manifest.json`, which resolves (HTTP 200).
Corrected to the canonical URL. Claude Code ignores `$schema` at load time (it is
editor-autocomplete metadata), so this changed no runtime behavior — but a `$schema` that
dereferences nothing gives an editor and a schema-CI check nothing to validate against, and
AC #1 requires the manifest to validate against its *declared* schema. With the corrected
URL, `plugin.json` validates against the canonical draft-07 schema (which requires only
`name`; `version` is optional — see below), and `.claude-plugin/marketplace.json` validates
against `https://json.schemastore.org/claude-code-marketplace.json` (already correct — HTTP
200, required `name`/`owner`/`plugins` all present).

### Affirmed conformant — the deliberate deviations (no change)

1. **No `version` field** — neither in `plugin.json` nor in the marketplace plugin entry.
   The canonical manifest schema marks `version` optional; the spec's *Version management*
   section documents that omitting it makes Claude Code content-address each install by git
   commit SHA (every commit is a new "version"). This is the continuous-ship posture, and
   *adding* a version re-introduces the #945 cache-freeze. **Do not add one.** See ADR
   [0110](0110-plugin-carries-no-version-continuous-ship.md). (The
   `metadata.version` on the marketplace *catalog* is a different field — it versions the
   catalog document, not any plugin's served content — and is untouched.)

2. **The `hooks` reference stays `"./hooks.json"` at the plugin root** — not moved to the
   spec-default `hooks/hooks.json`. The manifest `hooks` field accepts a string path (the
   canonical schema types it `anyOf: [string matching ^\./.*\.json$, object]`, described as
   hooks *in addition to* `hooks/hooks.json`); `"./hooks.json"` is therefore spec-valid, and
   with no `hooks/hooks.json` present it is the sole hook source (the `hooks/` dir holds only
   the `install.sh` + `guard.sh` scripts the config references via `${CLAUDE_PLUGIN_ROOT}`).
   Both the root-file+manifest-field shape and the default `hooks/hooks.json` shape are
   sanctioned; the root shape is kept deliberately because the §CP control-plane boundary is
   **path-coupled** to it — the canonical `CONTROL_PLANE_RE` carries a
   `^claude-plugins/kampus-pipeline/hooks(/|\.json$)` branch and `.github/CODEOWNERS` lists an
   explicit `/claude-plugins/kampus-pipeline/hooks.json` row, kept in sync by the
   `codeowners-cp.yml` gate. Moving the file would churn that gate machinery (ADRs 0103/0087
   §4, the exact path-coupling drift class §CP bounds) for zero spec benefit. Keep it.

3. **No `commands/` directory** — the spec treats commands as an optional component; the
   suite ships its capabilities as `skills/<name>/SKILL.md`, which the spec loads without a
   `commands/` present. No drift.

4. **`skills/` and `agents/` layouts match the spec.** Skills are `skills/<name>/SKILL.md`
   directories (the documented structure), with shared supporting files at the `skills/`
   root (`gh-issue-intake-formats.md`, `README.md`, the `validate-*.sh` scripts) that the
   scanner ignores because they are not `<name>/SKILL.md`. Agents are flat `agents/*.md`
   files at the plugin root — the documented `agents/` location.

5. **The `.claude/skills → ../claude-plugins/kampus-pipeline/skills` symlink is the
   local-discovery seam, reconciled and retained.** Claude Code's *plugin* discovery scans
   the plugin source-root `skills/`; phoenix's own *project-scope* discovery reads
   `.claude/skills/`. The relative symlink (mode-`120000`, clone-safe) points the latter at
   the former so there is exactly **one canonical home** with no duplicated content, and CI
   runs the validators through it (`bash .claude/skills/validate-skills.sh`). This is the
   ADR [0087](0087-plugin-dedicated-subdir-source.md) §2 / ADR
   [0062](0062-repo-as-config-plugin.md) §5 arrangement; the full rationale (and the
   accepted in-repo discovery doubling, ADR 0062 §5) is documented in
   [`claude-plugins/kampus-pipeline/skills/README.md`](../claude-plugins/kampus-pipeline/skills/README.md).

6. **The marketplace catalog entry keeps its dedicated-subdir `source`** —
   `"./claude-plugins/kampus-pipeline"` — so an install receives only that subtree, not the
   whole monorepo. ADR [0087](0087-plugin-dedicated-subdir-source.md). Required entry fields
   (`name`, `source`) are present; no plugin `version` (per §1). No drift.

7. **The plugin stays repo-agnostic** — every skill resolves its target repo from
   `CLAUDE_PIPELINE_REPO` → `gh repo view`, carrying no repo literal in the shipped manifest.
   ADR [0062](0062-repo-as-config-plugin.md). No drift.

## Consequences

- **The sibling `pipeline-crew` plugin (epic #2342) lands on an audited, uniform shape** —
  it mirrors the corrected `$schema` URL, the no-version posture, the subdir `source`, and
  the skills/agents layout from day one, instead of copying the first plugin's drift.
- **The recurring structural-audit false-positives are immunized.** A future audit (human
  or agent) that flags the missing `version`, the root-level `hooks.json`, the absent
  `commands/`, or the discovery symlink now has this record: each is documented-intentional
  with its forcing constraint, not an open defect to re-file — the same disposition ADR 0110
  established for `version` alone, now extended across the whole plugin surface.
- **Schema validation is now meaningful.** With a dereferenceable `$schema`, an editor and a
  schema-lint CI step can validate `plugin.json`; both manifests validate against their
  declared canonical schemas.
- **No runtime behavior changed.** `$schema` is load-time-ignored; the only edited byte is
  the manifest metadata URL. The §CP boundary, the hook wiring, and the discovery symlink are
  all unchanged.
- **Relates to:** ADR [0062](0062-repo-as-config-plugin.md) (repo-as-config / discovery
  symlink), ADR [0087](0087-plugin-dedicated-subdir-source.md) (subdir source / path
  coupling), ADR [0110](0110-plugin-carries-no-version-continuous-ship.md) (no version), ADR
  [0103](0103-consolidate-pipeline-cli-package.md) (hook surface), ADR
  [0150](0150-control-plane-covers-pipeline-agent-defs.md) (agents/ as §CP), and epic #2342 / #2346
  (Phase 1, Leg A — normalize).
</content>
</invoke>
