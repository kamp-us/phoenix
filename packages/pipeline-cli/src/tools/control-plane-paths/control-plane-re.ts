/**
 * The §CP control-plane boundary — the SINGLE source of truth (issue #2761).
 *
 * `CONTROL_PLANE_RE` is the one anchored regex that classifies which paths are
 * control-plane (human-merge-only, ADR 0053/0065/0073 §6/0100/0103/0150/0174). It
 * used to be hand-copied into ~10 live surfaces (5 gate skills, the formats-doc prose,
 * `codeowners-cp.ts`, and 3 vitest fixtures), guarded only by a byte-compare drift
 * check that missed the fixtures — so a stale fixture assertion ran only in
 * `merge_group` and silently ejected 3 green PRs (#2673). This const makes that
 * whole class unrepresentable: everything importable IMPORTS this, and the two
 * un-importable prose surfaces (the formats-doc `CONTROL_PLANE_RE=` line the live
 * gates read from `origin/main`, and `.github/CODEOWNERS`) are drift-guarded against
 * it — one definition, no copies.
 *
 * The runtime value (what `pipeline-cli control-plane-paths` prints) is the POSIX-ERE
 * grep/jq form the gates match against; the doubled backslashes here are TS string
 * escapes, so `\\.` is the value `\.` and `[^/]+\\.sh$` is the value `[^/]+\.sh$`.
 *
 * Anti-self-authorization is preserved (#981): the live merge-deciding gates still
 * re-resolve the boundary from the formats doc on `origin/main` at run time, so a
 * boundary-editing PR is classified against MAIN's boundary, not its own edit. This
 * const is the source the formats-doc line is kept in sync WITH — it does not move the
 * runtime resolution off the origin/main read.
 */
export const CONTROL_PLANE_RE =
	"^(\\.claude|\\.github)/|^claude-plugins/kampus-pipeline/skills/(ship-it|review-code|review-doc|review-skill|review-design|review-plan|triage|write-code|plan-epic|release|review-trivial)/|^claude-plugins/kampus-pipeline/skills/[^/]+\\.sh$|^claude-plugins/kampus-pipeline/agents/|^claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats\\.md$|^claude-plugins/kampus-pipeline/hooks(/|\\.json$)|^packages/ci-required/|^packages/pipeline-cli/";
