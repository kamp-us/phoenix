/**
 * The known-park recipe table — which parks a recipe verb may clear on its own, as data.
 *
 * Every entry names a park's leaf state, the one read that proves the park's cause is gone, and the
 * sentence a refusal quotes. Nothing here is derived at run time: ADR 0228's rule is that the verb
 * answers a decision it already owns, so the set of parks that clear autonomously is a literal in
 * this file and the founder's grill answer (epic #5840 — known clears, novel routes to a human) is
 * the shape of {@link classifyPark}'s result rather than a sentence in an operator's prompt.
 *
 * The parks themselves come from the lane machine, not from here: `blocked` and every `human:*`
 * state is a park (`lane/templates/coder.workflow.json`, and `operate` §4's routing table). A park
 * with no row below is **novel** — which is a decision this table records, not one a verb makes.
 *
 * A row keys on the leaf **and** the park cause the parking event named
 * ([`lane/report.ts`](../lane/report.ts)'s closed set, #6480). The leaf alone was never enough for
 * `blocked`, which thirteen distinct shell terminals fold into: it says a park happened and not why,
 * so every `blocked` was novel by construction and no row for one could be written at all.
 */

/** The clearance read a recipe relays. One constructor per read, so a new recipe cannot be prose. */
export type Clearance = "cp-approval" | "branch-free";

export interface ParkRecipe {
	/** The lane leaf state this recipe clears. */
	readonly park: string;
	/**
	 * The park cause this recipe keys on, or `null` for a park its leaf alone identifies.
	 *
	 * A row matches the cause it names and no other — `null` matches only a park carrying none. That
	 * is fail-closed on purpose: `BLOCKED` from `ship` folds to `human:cp-approval` whatever the
	 * block was (#5820), so a §CP row that ignored the cause would clear a park recorded for an
	 * entirely different reason by reading a §CP approval nobody was waiting on.
	 */
	readonly cause: string | null;
	/** The read whose answer decides whether the park's cause is gone. */
	readonly clearance: Clearance;
	/** What the park is waiting on, in one clause a refusal can quote. */
	readonly waitingOn: string;
}

/**
 * The parks with a fixed fix today: one keyed by its leaf, one by its cause.
 *
 * `human:cp-approval`'s clearance is `ship cp-approval`'s own discharge table (ADR 0175), relayed
 * rather than re-derived — the §CP cardinality question has exactly one answer in this package and a
 * second reading of it here would be the drift #2435 closed. `blocked` + `worktree-holds-branch` is
 * the #6395 shape, and its clearance is the inverse of the very read that refuses the build:
 * `build branch --resume-lane` refuses while a working tree holds the child's lane branch, so the
 * park is clear exactly when no working tree holds it.
 */
export const KNOWN_PARKS: ReadonlyArray<ParkRecipe> = [
	{
		park: "human:cp-approval",
		cause: null,
		clearance: "cp-approval",
		waitingOn: "a control-plane approval at the PR's current head",
	},
	{
		park: "blocked",
		cause: "worktree-holds-branch",
		clearance: "branch-free",
		waitingOn: "the working tree holding this build's lane branch to be removed",
	},
];

/** Whether a leaf state is a park at all — the lane machine's two park shapes. */
export const isPark = (leaf: string): boolean => leaf === "blocked" || leaf.startsWith("human:");

export type ParkClass =
	| {readonly _tag: "NotParked"; readonly leaf: string}
	| {readonly _tag: "Known"; readonly recipe: ParkRecipe}
	| {readonly _tag: "Novel"; readonly leaf: string; readonly reason: string};

/**
 * Classify one folded leaf state, and the cause its parking event named, against the table.
 *
 * A `blocked` still carries no cause when the shell that parked it named none, and it is novel then
 * for the reason it always was: the ledger recorded the event and not why, so no fixed fix keys on
 * it. What changed with #6480 is that a shell can now name one, and a named cause the table does not
 * carry is novel too — but it says which cause, so the gap is a row somebody can write rather than a
 * structural dead end.
 */
export const classifyPark = (leaf: string, cause: string | null): ParkClass => {
	if (!isPark(leaf)) return {_tag: "NotParked", leaf};
	const recipe = KNOWN_PARKS.find((row) => row.park === leaf && row.cause === cause);
	if (recipe !== undefined) return {_tag: "Known", recipe};
	return {_tag: "Novel", leaf, reason: novelReason(leaf, cause)};
};

const novelReason = (leaf: string, cause: string | null): string => {
	if (cause !== null) {
		return `the park "${leaf}" names the cause "${cause}", which no recipe covers`;
	}
	return leaf === "blocked"
		? "a bare BLOCKED park records the event and not its cause, so no fixed fix keys on it"
		: `no recipe covers the park "${leaf}"`;
};
