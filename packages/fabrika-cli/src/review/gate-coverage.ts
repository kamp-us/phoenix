/**
 * Did any of the repo's own workflows inspect these bytes?
 *
 * `rollup.ts` answers what the check runs at a head concluded. It cannot answer *which* workflows
 * produced them, so a head where only a platform-provided workflow reported rolls up `green` while
 * every gate the repo relies on never saw the bytes (#6522). A conflicted branch is the ordinary way
 * in: GitHub stops creating `pull_request` runs, CodeQL's default setup keeps reporting on its own
 * trigger, and `green` and "no gate ran" become one word.
 *
 * **The gate set is the live inventory, never a name this module knows.** A workflow checked into
 * the repo is addressed by its file path; one the platform provides on the repo's behalf — default
 * CodeQL setup, Dependabot, the Copilot reviewer — is addressed as `dynamic/<provider>/<name>`. That
 * prefix is the platform's own marker, which is why the discriminator can be structural: no expected
 * job names, no second copy of the repo's CI shape to drift (#5603, R17.1).
 */

/** The prefix every workflow file checked into a repository is addressed by. */
const REPO_AUTHORED = ".github/workflows/";

/** Whether a workflow path names a file in the repository rather than a platform-provided one. */
export const isRepoAuthored = (path: string): boolean => path.startsWith(REPO_AUTHORED);

export type GateCoverage =
	/** At least one repo-authored workflow produced a run here — the rollup is over gated bytes. */
	| {readonly _tag: "Covered"; readonly declared: number; readonly covered: number}
	/** The repo declares gates and none of them ran at this head. Never a shade of green. */
	| {readonly _tag: "Uncovered"; readonly declared: number}
	/** The repo authors no workflow of its own, so there is no gate to have missed. */
	| {readonly _tag: "NoGates"};

/**
 * The coverage of one head, over the repo's inventory and the workflows that ran at it.
 *
 * The covered set is the *intersection*: a run whose path is not in the live inventory proves
 * nothing about the repo's current gates, and a gate in the inventory that produced no run here is
 * exactly the miss being looked for.
 */
export const gateCoverageOf = (
	inventory: ReadonlyArray<string>,
	ranAtHead: ReadonlyArray<string>,
): GateCoverage => {
	const gates = new Set(inventory.filter(isRepoAuthored));
	if (gates.size === 0) return {_tag: "NoGates"};
	const covered = new Set(ranAtHead.filter((path) => gates.has(path)));
	return covered.size === 0
		? {_tag: "Uncovered", declared: gates.size}
		: {_tag: "Covered", declared: gates.size, covered: covered.size};
};
