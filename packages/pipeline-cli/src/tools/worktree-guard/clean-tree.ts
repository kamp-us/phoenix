/**
 * `worktree-guard assert-clean` decision core — the fail-closed clean-tree assertion (#2666).
 *
 * LAYER 2 containment for the worktree-corruption class: a freshly provisioned worktree is
 * *supposed* to come up pristine, but #2666 caught one that came up dirty (an unauthored
 * uncommitted hunk present at spawn) — which then rode into a commit via a stage-all. This decides
 * whether a `git status --porcelain <path>` reading proves the tree CLEAN, so a caller (write-code
 * before its first Edit, review-code right after `git worktree add`) can STOP LOUD on a dirty tree
 * instead of proceeding to author on top of contamination.
 *
 * Fail-closed by construction: only an empty porcelain reading is `clean`; a non-empty reading is
 * `dirty`, and an *indeterminate* reading (git couldn't run — `porcelain === null`) is also `dirty`
 * (never a false clean). The command IS the ground truth; this core only maps its output to a stop.
 */

export type CleanTreeDecision =
	| {readonly kind: "clean"; readonly reason: string}
	| {readonly kind: "dirty"; readonly reason: string};

/** First N porcelain lines, for a legible refusal (the whole listing can be long). */
const preview = (porcelain: string, n = 10): string =>
	porcelain
		.trim()
		.split("\n")
		.slice(0, n)
		.map((l) => `    ${l}`)
		.join("\n");

/**
 * Decide whether the target tree is clean from a `git status --porcelain` reading.
 *
 * - `porcelain === null` (git status could not be run — not a repo, path missing) → **dirty**
 *   (fail-closed: an indeterminate tree is never certified clean).
 * - empty/whitespace-only reading → **clean**.
 * - any other reading → **dirty**, with a bounded preview of the offending entries.
 */
export const decideCleanTree = (args: {
	readonly path: string;
	readonly porcelain: string | null;
}): CleanTreeDecision => {
	const {path, porcelain} = args;
	if (porcelain === null) {
		return {
			kind: "dirty",
			reason: `could not read \`git status --porcelain\` at ${path} — treating as DIRTY (fail-closed; an indeterminate tree is never certified clean).`,
		};
	}
	if (porcelain.trim() === "") {
		return {kind: "clean", reason: `worktree at ${path} is clean (empty porcelain).`};
	}
	return {
		kind: "dirty",
		reason: `worktree at ${path} is DIRTY — a fresh worktree must come up pristine (#2666); refusing to proceed on a contaminated tree. Entries:\n${preview(porcelain)}`,
	};
};
