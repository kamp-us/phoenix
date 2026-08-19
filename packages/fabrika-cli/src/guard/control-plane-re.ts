/**
 * The §CP control-plane boundary — the one anchored regex that says which paths are human-merge-only
 * (ADR 0053/0065/0100/0150/0174/0193/0212/0218).
 *
 * It lives as a const rather than a literal each consumer copies: it used to be hand-copied into
 * ~10 surfaces guarded only by a byte-compare that missed three vitest fixtures, and a stale fixture
 * assertion ran only in `merge_group` and silently ejected 3 green PRs (#2673). Everything
 * importable imports this.
 *
 * The value is the POSIX-ERE grep/jq form; the doubled backslashes are TS escapes, so `\\.` is the
 * value `\.`.
 *
 * Two branch groups are worth naming because their scope is not obvious from the pattern:
 *
 * - The kampus-pipeline clauses cover whole DIRECTORIES, not file types (founder ruling on #4446).
 *   `.github/CODEOWNERS` has no `*` catch-all and the `main` ruleset pairs
 *   `required_approving_review_count: 0` with `require_code_owner_review: true`, so a path matching
 *   NO row merges on ZERO approvals — which made a non-`.sh` file beside a gated script ungated.
 * - The pipeline-cli clauses cover an enforcement CORE, not the package (ADR 0218): the
 *   non-recursive `src/` root that every gate dispatches through, the eight tools that ARE the
 *   enforcement surface, and `tracker/gh-io.ts` alone, whose `authorizedAuthors` is the ADR-0055
 *   write+ ACL a verdict's authority is resolved against.
 */

export const CONTROL_PLANE_RE =
	"^(\\.claude|\\.github)/|^\\.claude-plugin/|^claude-plugins/kampus-pipeline/skills/|^claude-plugins/kampus-pipeline/lib/|^claude-plugins/kampus-pipeline/agents/|^claude-plugins/kampus-pipeline/hooks(/|\\.json$)|^packages/ci-required/|^packages/pipeline-cli/src/[^/]+$|^packages/pipeline-cli/src/tools/(ci-required|codeowners-cp|control-plane-paths|cp-cardinality|cp-classify|review-head|trivial-diff|verdict)/|^packages/pipeline-cli/src/tools/tracker/gh-io\\.ts$|^biome\\.jsonc$|^biome-plugins/|^([^/]+/)*(lefthook|\\.lefthook)[^/]+$";
