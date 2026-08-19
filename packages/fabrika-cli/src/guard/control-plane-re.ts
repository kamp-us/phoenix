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
 * - The kampus-pipeline clauses (skills/, lib/, agents/, hooks) retired with the plugin itself
 *   (#5937), and ADR 0218's enforcement-core clauses over the v1 verb package retired with that
 *   package (#6100): both trees are deleted, so they classified paths that can no longer
 *   exist, and their CODEOWNERS rows went with them.
 * - `^packages/fabrika-cli/src/ci/` is the ONE §CP path in THIS package, and the narrowness is the
 *   ruling, not an omission: `ci-required`'s verdict core lives here, and it must stay covered or
 *   it lands matching no CODEOWNERS row, which merges at zero approvals. The rest of the package is
 *   ordinary by founder ruling on #6164 (ADR 0299).
 */

export const CONTROL_PLANE_RE =
	"^(\\.claude|\\.github)/|^\\.claude-plugin/|^packages/ci-required/|^packages/fabrika-cli/src/ci/|^biome\\.jsonc$|^biome-plugins/|^([^/]+/)*(lefthook|\\.lefthook)[^/]+$";
