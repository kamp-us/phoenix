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
 * - A `DONE` out of `build` or `build:ui` claims `OpenPull`, which `./prove-verb.ts` answers `proven` for on the
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
 *
 * **The `build` leaf came back on a different question, and {@link buildingBy} is its walk.** The
 * paragraph above is about *finishing* a build, which stays off limits for the reason it gives. What
 * the spawn arm asks is whether the builder is **gone**, which turns on live board residue rather
 * than on an offline proof — so the conjunction it reads is the verb's, written once in that verb's
 * `lane recover --help` description in `./command.ts`. What lives here is the offline
 * half: which tasks to ask about ({@link buildingBy}), where a builder in each role would have left
 * its work ({@link publicationOf}), and the park those reads record ({@link DEAD_SPAWN_EVENT},
 * {@link DEAD_SPAWN_CAUSE}).
 *
 * **The queue arm asks a third question: has the merge queue already answered?** A task in
 * `ship:queued` owes no proven event, because its PR is just waiting. But the queue can finish with it
 * after the shipper's watch ended, and then all that is missing is the one read a driver pass makes.
 * {@link queuedBy} finds those tasks, {@link queuedPullOf} names the PR their own ledger recorded, and
 * {@link QUEUE_SETTLEMENTS} is the operate skill's `ship:queued` table minus the rows that spend a
 * wait or park: the sweep relays a landing or an ejection and records nothing else. A `parked`
 * answer records nothing either, but it is not a wait: per that table it owes
 * `ship disarm <pr> --site post-enqueue` now, so it is its own settlement and its own row.
 */

import type {Reconciled} from "../ship/reconcile-verb.ts";
import {isBuildState, shellState} from "../wire/lane-brief.ts";
import type {LaneStatus, LogEntry} from "./fold.ts";
import type {LaneRole} from "./prove.ts";
import {REVIEW_STATE, REVIEW_UI_STATE, SHIP_QUEUED_STATE} from "./prove.ts";
import {pullNumberIn} from "./reconcile.ts";

/**
 * The event each leaf owes its ledger, keyed by the leaf a killed shell would have left the task in.
 *
 * Derived from the state names `./prove.ts` exports rather than spelled out again, so a machine that
 * renames a cell moves both readings at once or neither. Every one of `BUILD_STATES` is absent on
 * purpose and the module docblock carries why: its `DONE` proves on an open PR, which a live builder
 * has too.
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

/**
 * The event and the cause the spawn arm records — the `blocked` + `spawn-dead` row's own park.
 *
 * Named here rather than spelled at the append so the arm and the recipe that clears it cannot come
 * to disagree about which park this is: `../recipe/parks.ts` keys its clearance on exactly this pair.
 */
export const DEAD_SPAWN_EVENT = "BLOCKED";
export const DEAD_SPAWN_CAUSE = "spawn-dead";

/**
 * Every task of a non-terminal lane standing in a leaf a **builder** runs in.
 *
 * The second walk of one sweep, and it is deliberately not {@link owedBy}'s: a build leaf owes its
 * ledger no event at all ({@link OWED_EVENTS} leaves it out, and the module docblock carries why),
 * so what the spawn arm asks about it is the opposite question — not "did a finished shell already
 * earn an event nobody recorded", but "is the shell that took this leaf gone, leaving the lane
 * holding a seat nothing will ever move".
 *
 * `build:ui` is in, because a killed rendered-surface builder strands a lane exactly as a text one
 * does; the membership is read off {@link isBuildState} rather than a list here, so a sixth shell
 * state cannot join one reading and not the other. An epic child region is in for the same reason
 * and arrives by a different route — `./prove.ts`'s `issueOf` resolves an `issue_<n>` task — so what
 * this walk returns spans two leaves and three roles, and {@link publicationOf} is what keeps the
 * arm's third read answerable for every one of them.
 *
 * Empty on a terminal lane for {@link owedBy}'s reason: a done lane holds no seat, and asking the
 * board about one would spend a read per finished lane on every sweep.
 */
export const buildingBy = (status: LaneStatus): ReadonlyArray<TaskLeaf> => {
	if (status.status === "done") return [];
	return activeTaskLeaves(status).filter(({leaf}) => {
		const state = shellState(leaf);
		return state !== null && isBuildState(state);
	});
};

/**
 * Where a builder in this role leaves its work when it gets far enough to leave any — the surface
 * the spawn arm's third conjunct has to read before it may call a lane abandoned.
 *
 * It turns on the **role** and not the leaf, because publishing is a property of the lane shape: a
 * single lane and an epic tail open a pull request, and a `build:ui` leaf opens the same one a
 * `build` leaf does. An epic child opens none by design — one epic run is one branch and one PR, and
 * the tail owns it — so a child's work is visible only as commits on its own lane branch.
 *
 * **This table exists because `./prove.ts`'s does not answer here.** `claimOf` says what a *recorded
 * event* asserts, and a child's `DONE` answers `RangeCommits` there. Borrowing it for this question
 * gave a child a range read, and the arm reported it as a PR read that "did not settle" — a reason
 * naming an inspection nobody made, over a population that could then never reach a park at all.
 * So the arm asks this instead, and each answer names one read it makes:
 * `OpenPull` is the board read, and `LaneBranch` is the branch read the conjunct before it already
 * took.
 */
export type Publication =
	/** The board carries it: an open pull request whose body links the issue. */
	| {readonly _tag: "OpenPull"}
	/** This clone carries it: commits on the child's own lane branch, and never a pull request. */
	| {readonly _tag: "LaneBranch"};

export const publicationOf = (role: LaneRole): Publication =>
	role._tag === "Child" ? {_tag: "LaneBranch"} : {_tag: "OpenPull"};

/** Every task of a non-terminal lane waiting in the merge-queue dwell. */
export const queuedBy = (status: LaneStatus): ReadonlyArray<TaskLeaf> => {
	if (status.status === "done") return [];
	return activeTaskLeaves(status).filter(({leaf}) => leaf === SHIP_QUEUED_STATE);
};

/** The pull request a task's ledger names, as its URL and its number. */
export interface QueuedPull {
	readonly url: string;
	readonly number: number;
}

/**
 * The PR this task's own ledger names last, or `null` where no line of it carries a PR URL.
 *
 * The last one, because a lane that went round records each new PR after the one it replaced. Only
 * a URL counts: `lane report --pr` hands the ref to the closure read, which reads a URL alone, so a
 * bare `#N` would record a landing whose closure nobody could read.
 */
export const queuedPullOf = (entries: ReadonlyArray<LogEntry>, task: string): QueuedPull | null => {
	for (const entry of [...entries].reverse()) {
		if (entry.task !== task || entry.pr === undefined) continue;
		const number = pullNumberIn(entry.pr);
		if (number !== null) return {url: entry.pr, number};
	}
	return null;
};

/** What the sweep does with one `ship reconcile --polls 1` answer. */
export type Settlement =
	/** The queue finished with the PR, so this `lane report` token records its answer. */
	| {readonly _tag: "Record"; readonly token: "LANDED" | "EJECTED"}
	/** The PR is still queued: the row names it, nothing lands, and a later pass re-reads it. */
	| {readonly _tag: "Hold"; readonly why: string}
	/**
	 * The `--auto` arm never took effect and still stands, so a disarm is owed now, before any record.
	 * The sweep runs no disarm and records nothing: clearing merge intent is the driver's act, and the
	 * record that follows turns on what that disarm answers.
	 */
	| {readonly _tag: "DisarmOwed"; readonly why: string};

/**
 * The queue arm's relay table, keyed on every answer `ship reconcile` can give.
 *
 * A driver pass records `unresolved` as `UNRESOLVED`, and on `parked` runs
 * `ship disarm <pr> --site post-enqueue` first, then records off the disarm's answer. The sweep
 * records neither: the first would spend a wait on the sweep's clock rather than the queue's, and the
 * second turns on a disarm the driver runs. `parked` is never a wait, because a live arm left
 * standing enqueues ungated later.
 */
export const QUEUE_SETTLEMENTS: Readonly<Record<Reconciled, Settlement>> = {
	landed: {_tag: "Record", token: "LANDED"},
	ejected: {_tag: "Record", token: "EJECTED"},
	unresolved: {
		_tag: "Hold",
		why: "the PR is still in the queue, and a sweep records no wait, so the lane's wait budget is untouched",
	},
	parked: {
		_tag: "DisarmOwed",
		why: "the `--auto` arm sat unqueued past `ship reconcile`'s floor, so the enqueue never took effect and a live arm left standing enqueues ungated later. This is not a wait",
	},
};
