/**
 * Did any of the repo's own workflows inspect these bytes?
 *
 * `rollup.ts` answers what the check runs at a head concluded. It cannot answer *which* workflows
 * produced them, so a head where only a platform-provided workflow reported rolls up `green` while
 * every gate the repo relies on never saw the bytes. A conflicted branch is the ordinary way
 * in: GitHub stops creating `pull_request` runs, CodeQL's default setup keeps reporting on its own
 * trigger, and `green` and "no gate ran" become one word.
 *
 * **The gate set is the live inventory, never a name this module knows.** A workflow checked into
 * the repo is addressed by its file path; one the platform provides on the repo's behalf — default
 * CodeQL setup, Dependabot, the Copilot reviewer — is addressed as `dynamic/<provider>/<name>`. That
 * prefix is the platform's own marker, which is why the discriminator can be structural: no expected
 * job names, no second copy of the repo's CI shape to drift.
 *
 * **A repo-authored path is necessary and not sufficient, because a path says which file ran and
 * never which bytes it opened.** `.github/workflows/pr-cleanup.yml` is checked into this repo and
 * runs on `pull_request_target`, which GitHub executes against the *base* ref while labelling the
 * run with the pull request's head SHA — so the run is repo-authored, sits at the head, and
 * inspected none of it. That one run cleared this floor on a conflicted PR whose real gates had
 * never started, and the verb printed `green`. So coverage reads each run's own provenance:
 * the head it carries, and the event that produced it ({@link inspectsHead}).
 *
 * `ship checks` asks the same question at its own `green` and asks it through this module
 * rather than a ship-side copy — the merge authority and the review gate reading one head must not
 * be able to disagree about which gates ran on it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8362
 */

/** The prefix every workflow file checked into a repository is addressed by. */
const REPO_AUTHORED = ".github/workflows/";

/** Whether a workflow path names a file in the repository rather than a platform-provided one. */
export const isRepoAuthored = (path: string): boolean => path.startsWith(REPO_AUTHORED);

/**
 * The fields of one workflow run that say which bytes it opened.
 *
 * Three, because no two of them answer the question alone: the path says whether the repo authors
 * the gate, the head says which commit the run was created for, and the event says whether that
 * head is what the job checked out.
 */
export interface RunProvenance {
	/** The workflow file this run came from, as the inventory addresses it. */
	readonly path: string;
	/** The event that created the run — `pull_request`, `push`, `workflow_dispatch`, and so on. */
	readonly event: string;
	/** The full 40-character commit the run is labelled with. */
	readonly headSha: string;
}

/**
 * The events GitHub runs against a ref other than the head they are labelled with.
 *
 * One member, and it is a documented platform behaviour rather than a policy choice: a
 * `pull_request_target` run is created in the context of the base repository and a plain
 * `actions/checkout` there gets the base ref, while the run's `head_sha` is still the pull
 * request's head. Every other event is judged by the head it carries — a blanket exclusion of
 * `push` or `workflow_dispatch` would reject `.github/workflows/ci.yml`'s deliberate
 * trusted-dispatch path for Release-PR head inspection, which does open the head it names.
 */
const BASE_CONTEXT_EVENTS: ReadonlySet<string> = new Set(["pull_request_target"]);

/** A commit resolved to its full object name — the only head this module will judge against. */
const FULL_OID = /^[0-9a-f]{40}$/;

/**
 * Whether one run's provenance establishes that it opened `head`.
 *
 * The head comparison is exact rather than a prefix, and the resolution that makes it safe belongs
 * to the caller: an abbreviated operand and its full SHA must judge the same, so a caller reads the
 * commit's own object name once and binds this read to it. A prefix here would instead let a short
 * operand match a run at some other commit.
 */
export const inspectsHead = (run: RunProvenance, head: string): boolean =>
	run.headSha === head && !BASE_CONTEXT_EVENTS.has(run.event);

export type GateCoverage =
	/** At least one repo-authored workflow inspected this head — the rollup is over gated bytes. */
	| {readonly _tag: "Covered"; readonly declared: number; readonly covered: number}
	/** The repo declares gates and none of them inspected this head. Never a shade of green. */
	| {readonly _tag: "Uncovered"; readonly declared: number}
	/** The repo authors no workflow of its own, so there is no gate to have missed. */
	| {readonly _tag: "NoGates"}
	/** The provenance coverage needs could not be read, so coverage is UNKNOWN — never `Uncovered`. */
	| {readonly _tag: "Unreadable"; readonly reason: string};

/**
 * The coverage of one head, over the repo's inventory and the runs that carry that head.
 *
 * `head` is the commit's full object name, and an operand short of one is `Unreadable` rather than
 * `Uncovered`: the two route to different exits on purpose, because "nothing inspected these bytes"
 * is a fact about the repository and an unresolved operand is a fact about the call. Reporting the
 * second as the first is what sent a reviewer to re-push a head whose CI was already green.
 *
 * The covered set is the *intersection*: a run whose path is not in the live inventory proves
 * nothing about the repo's current gates, and a gate in the inventory that produced no
 * head-inspecting run here is exactly the miss being looked for.
 */
export const gateCoverageOf = (
	inventory: ReadonlyArray<string>,
	ranAtHead: ReadonlyArray<RunProvenance>,
	head: string,
): GateCoverage => {
	if (!FULL_OID.test(head)) {
		return {
			_tag: "Unreadable",
			reason: `"${head}" is not a resolved 40-character commit, so which runs carry this head cannot be judged`,
		};
	}
	const gates = new Set(inventory.filter(isRepoAuthored));
	if (gates.size === 0) return {_tag: "NoGates"};
	const covered = new Set(
		ranAtHead
			.filter((run) => gates.has(run.path) && inspectsHead(run, head))
			.map((run) => run.path),
	);
	return covered.size === 0
		? {_tag: "Uncovered", declared: gates.size}
		: {_tag: "Covered", declared: gates.size, covered: covered.size};
};
