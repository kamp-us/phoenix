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
 */

/** The clearance read a recipe relays. One constructor per read, so a new recipe cannot be prose. */
export type Clearance = "cp-approval";

export interface ParkRecipe {
	/** The lane leaf state this recipe clears. */
	readonly park: string;
	/** The read whose answer decides whether the park's cause is gone. */
	readonly clearance: Clearance;
	/** What the park is waiting on, in one clause a refusal can quote. */
	readonly waitingOn: string;
}

/**
 * `human:cp-approval` is the one park with a fixed fix today.
 *
 * Its clearance is `ship cp-approval`'s own discharge table (ADR 0175), relayed rather than
 * re-derived — the §CP cardinality question has exactly one answer in this package and a second
 * reading of it here would be the drift #2435 closed.
 */
export const KNOWN_PARKS: ReadonlyArray<ParkRecipe> = [
	{
		park: "human:cp-approval",
		clearance: "cp-approval",
		waitingOn: "a control-plane approval at the PR's current head",
	},
];

/** Whether a leaf state is a park at all — the lane machine's two park shapes. */
export const isPark = (leaf: string): boolean => leaf === "blocked" || leaf.startsWith("human:");

export type ParkClass =
	| {readonly _tag: "NotParked"; readonly leaf: string}
	| {readonly _tag: "Known"; readonly recipe: ParkRecipe}
	| {readonly _tag: "Novel"; readonly leaf: string; readonly reason: string};

/**
 * Classify one folded leaf state against the table.
 *
 * A bare `blocked` is novel by construction and says so: the ledger records the event, never the
 * cause, so there is nothing for a fixed fix to key on. That is the honest answer, and stating it
 * here is what keeps a caller from reading "no recipe" as "no problem".
 */
export const classifyPark = (leaf: string): ParkClass => {
	if (!isPark(leaf)) return {_tag: "NotParked", leaf};
	const recipe = KNOWN_PARKS.find((row) => row.park === leaf);
	if (recipe !== undefined) return {_tag: "Known", recipe};
	return {
		_tag: "Novel",
		leaf,
		reason:
			leaf === "blocked"
				? "a bare BLOCKED park records the event and not its cause, so no fixed fix keys on it"
				: `no recipe covers the park "${leaf}"`,
	};
};
