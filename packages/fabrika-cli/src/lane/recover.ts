/**
 * What a non-terminal lane's leaf still owes its ledger — the pure half of `lane recover`.
 *
 * A shell posts its SHA-bound verdict on the artifact and then records the event. When it dies
 * between the two, the verdict stands on the PR and the ledger never learns it: the lane sits in
 * `review` carrying a provable `PASS` until somebody thinks to run `lane prove` by hand. Nothing in
 * the engine asked the lane's own artifact whether the event this state owes is already proven —
 * `./stale.ts` derives silence against a shell budget and reads no artifact, and `./reconcile.ts`
 * reads one but asks whether an already-recorded closure line can be trusted.
 *
 * This module answers the two offline questions that sweep needs, so both are testable without a
 * network: which event a leaf owes, and which of a lane's tasks are standing in a leaf that owes one.
 *
 * **The owed set is `./prove.ts`'s own, minus every arm a live shell also satisfies.** `claimOf` says
 * which event out of which leaf asserts a checkable artifact, and {@link OWED_EVENTS} is the arms
 * whose artifact a *finished* shell alone can produce: a `PASS` out of `review`, a `PASS` out of
 * `review:ui`. Two of `claimOf`'s arms are left out, and for one reason — each is satisfied by a
 * shell that is merely still working, so an unattended sweep standing on it would fold a lane out
 * from under a live one.
 *
 * - A `BLOCKED` out of either review cell claims `ParkUncontradicted`, which asserts that the
 *   reviewer's run reached **no** verdict. A negative like that is proven by the absence of a
 *   contradiction rather than by an artifact somebody posted, so the sweep would park every lane
 *   whose reviewer has simply not finished yet.
 * - A `DONE` out of `build` claims `OpenPull`, which `./prove-verb.ts` answers `proven` for on the
 *   existence of one open PR whose body links the issue — a fact about the PR being *open*, never
 *   about the builder being *done* with it. A lane in a repair round carries exactly that PR for the
 *   whole round, so the sweep would move it to `review` while the builder is still pushing. The
 *   damage is bounded — the reviewer at head FAILs the unrepaired PR and the lane comes back — but
 *   it costs a review round and leaves the builder's own `lane report DONE` refusing against a lane
 *   that already moved, which is the park this sweep exists to prevent, not to cause.
 *
 * Reopening the `build` arm needs a claim the open PR alone does not carry — the builder's own
 * terminal, or a head the reviewer has not yet seen — and none of those is readable offline today.
 * A park is a thing a person or a driver decides, and so is calling a build finished; this records
 * the verdicts a shell already posted and died before writing.
 */

import type {LaneStatus} from "./fold.ts";
import {REVIEW_STATE, REVIEW_UI_STATE} from "./prove.ts";

/**
 * The event each leaf owes its ledger, keyed by the leaf a killed shell would have left the task in.
 *
 * Derived from the state names `./prove.ts` exports rather than spelled out again, so a machine that
 * renames a cell moves both readings at once or neither. `BUILD_STATE` is absent on purpose and the
 * module docblock carries why: its `DONE` proves on an open PR, which a live builder has too.
 */
export const OWED_EVENTS: Readonly<Record<string, string>> = {
	[REVIEW_STATE]: "PASS",
	[REVIEW_UI_STATE]: "PASS",
};

/** The event this leaf owes, or `null` where nothing recorded out of it claims a readable artifact. */
export const owedEvent = (leaf: string): string | null => OWED_EVENTS[leaf] ?? null;

/** One task standing in a leaf, named so a row can say which task of an epic lane it judged. */
export interface TaskLeaf {
	readonly task: string;
	readonly leaf: string;
}

/**
 * The active phase's tasks paired with their leaves.
 *
 * The active phase is the one entry whose value is an object — the same structural recognition
 * `applyEvent` makes when it refuses an event addressed to a task outside it, so a row this returns
 * is a row the appending verb can actually act on. A future phase is the string `"waiting"` and a
 * done workflow is a bare terminal name, and both answer empty.
 */
export const activeTaskLeaves = (status: LaneStatus): ReadonlyArray<TaskLeaf> => {
	if (typeof status.stateValue === "string") return [];
	const leaves: TaskLeaf[] = [];
	for (const phase of Object.values(status.stateValue)) {
		if (typeof phase === "string") continue;
		for (const [task, leaf] of Object.entries(phase)) leaves.push({task, leaf});
	}
	return leaves;
};

/**
 * Every task of a non-terminal lane that is standing in a leaf owing a provable event.
 *
 * Empty on a lane the fold reads `done`: a terminal lane owes its ledger nothing, and asking the
 * board about one would spend a read per finished lane on every sweep.
 */
export const owedBy = (
	status: LaneStatus,
): ReadonlyArray<{readonly task: string; readonly leaf: string; readonly event: string}> => {
	if (status.status === "done") return [];
	const owed: Array<{task: string; leaf: string; event: string}> = [];
	for (const {task, leaf} of activeTaskLeaves(status)) {
		const event = owedEvent(leaf);
		if (event !== null) owed.push({task, leaf, event});
	}
	return owed;
};
