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
 *
 * The pairing binds one direction: every row keys on a real cause, and a cause is free to stand with
 * no row here (ADR 0339). This table is priced at a proving read; naming a park is not.
 */

/** The clearance read a recipe relays. One constructor per read, so a new recipe cannot be prose. */
export type Clearance =
	| "cp-approval"
	| "branch-free"
	| "campaign-active"
	| "spawn-clear"
	| "queue-moved";

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
	/**
	 * The verb the clearance runs to remove the park's cause before re-reading, or `null` for a
	 * clearance that only waits on somebody else.
	 *
	 * A row naming one is a row that clears itself: `branch-free` sat at exit 13 forever without one,
	 * because reading whether a tree still holds the branch cannot make it stop (#6610). A row naming
	 * `null` is deliberate, not unfinished — `cp-approval` waits on a human's judgment, and a recipe
	 * that "removed" that cause would be granting the approval.
	 */
	readonly remedy: string | null;
	/** What the park is waiting on, in one clause a refusal can quote. */
	readonly waitingOn: string;
}

/**
 * Waits a `queue-moved` clear grants the resumed lane, on the line that clears the park.
 *
 * One, because one conclusive read is what a moved queue needs: `reconcile` already answered
 * `landed` or `ejected`, so the resumed lane's next `WIP` is the read that records that outcome, not
 * the start of another dwell. Granting the whole budget again would let a lane that keeps clearing
 * on a stale answer wait forever.
 */
export const QUEUE_MOVED_GRANT = 1;

/**
 * The parks with a fixed fix today: two keyed by their leaf, three by their cause.
 *
 * `human:cp-approval`'s clearance is `ship cp-approval`'s own discharge table (ADR 0175), relayed
 * rather than re-derived — the §CP cardinality question has exactly one answer in this package and a
 * second reading of it here would be the drift #2435 closed. `blocked` + `worktree-holds-branch` is
 * the #6395 shape, and its clearance is the inverse of the very read that refuses the build:
 * `build branch --resume-lane` refuses while a working tree holds the child's lane branch, so the
 * park is clear exactly when no working tree holds it — and since #6610 the clearance first runs
 * `build retire`, which takes that checkout back when the board licenses it (ADR 0323). Without the
 * remedy the row read the pin and could never remove it, so every lane parked on this cause sat at
 * exit 13 until a human ran `git worktree remove` by hand.
 *
 * `blocked` + `campaign-paused` is #7217, and its clearance is the dispatch permission read back:
 * ADR 0304 makes the lane milestone's `## Campaigns` `State` cell the whole answer, so the park is
 * clear exactly when that cell reads `active` at the trunk. It names no remedy because resuming a
 * campaign is a human's judgment recorded through `campaign state` — a recipe that "removed" this
 * cause would be granting the dispatch it is only allowed to observe.
 *
 * `blocked` + `spawn-dead` is #6770, and it is the one row whose clearance reads the lane rather than
 * the cause itself: no verb can spawn an agent to find out whether the provider is back, so the
 * operator's next dispatch is that test and this row proves only that the dispatch can happen — no
 * claim of the dead shell's is standing, and no working tree still holds its lane branch. Both are
 * the residue ADR 0321 makes the driver's to clear, so a park whose obligations were discharged
 * clears on the first pass and one whose stranded claim needs a `build adopt` holds at exit 13,
 * which is where ADR 0295 puts it.
 *
 * `human:queue-stall` is #6717, and it is the second row keyed by its leaf alone: a `WIP` carries no
 * park cause and `lane report` refuses one on any non-`BLOCKED` event, so the leaf is all there is
 * to key on. It does not collide with the §CP row keyed on the same `null` because the leaves
 * differ. Its clearance is `ship reconcile`'s answer relayed (ADR 0228) — no verb in this tree can
 * read the queue's own position, so the row turns on the two outcomes that already exist, `landed`
 * and `ejected`. It names no remedy for the same reason `campaign-active` does not: a recipe that
 * "removed" this cause would be merging the PR. What it does instead is grant, because the founder's
 * ruling on #6717 makes the recipe the grantor — the clear and the wait it buys ride one recorded
 * event, so there is no bare `UNBLOCKED` into a spent budget for the fold to refuse.
 */
export const KNOWN_PARKS: ReadonlyArray<ParkRecipe> = [
	{
		park: "human:cp-approval",
		cause: null,
		clearance: "cp-approval",
		remedy: null,
		waitingOn: "a control-plane approval at the PR's current head",
	},
	{
		park: "human:queue-stall",
		cause: null,
		clearance: "queue-moved",
		remedy: null,
		waitingOn: "the merge queue to move this PR — to land it, or to eject it",
	},
	{
		park: "blocked",
		cause: "worktree-holds-branch",
		clearance: "branch-free",
		remedy: "fabrika build retire",
		waitingOn: "the working tree holding this build's lane branch to be removed",
	},
	{
		park: "blocked",
		cause: "campaign-paused",
		clearance: "campaign-active",
		remedy: null,
		waitingOn: "the campaign homing this lane's milestone to read active again",
	},
	{
		park: "blocked",
		cause: "spawn-dead",
		clearance: "spawn-clear",
		remedy: "fabrika build retire",
		waitingOn:
			"the dead shell's claim and working tree to be gone so the brief can be dispatched again",
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
