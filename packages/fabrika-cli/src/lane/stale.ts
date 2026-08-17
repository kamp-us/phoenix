/**
 * The stall derivation — a lane's folded state plus the age of its last event, judged.
 *
 * The ledger records state, not liveness: when the shell driving a lane dies, the last recorded
 * state stays on disk and every reader still sees an active lane (#5897). Nothing new is stored to
 * fix that. Every event line already carries an ISO `at`, so "how long since this lane moved" is
 * already on disk, and this module is the reading of it.
 *
 * The judgement turns on one question — **should something be driving this lane right now?** Three
 * dispositions answer it and only one is judged against the clock:
 *
 *   - A lane whose fold is `done` has no driver by design.
 *   - A lane where no task can be driven and at least one sits in a **park** — `blocked` or a
 *     `human:*` state — is waiting on a person, and waiting is what a park is for. It may sit for
 *     days without that being a defect.
 *   - Everything else is a lane something is supposed to be doing: a task in a state that routes to
 *     a shell (`lane brief`'s own routing, so the two agree by construction), or a `queued` task
 *     nobody has dispatched. Silence there is the defect.
 */
import {shellState} from "../wire/lane-brief.ts";
import type {LaneStatus} from "./fold.ts";

/** The default silence a lane may hold before it is called stale, in minutes. */
export const DEFAULT_STALE_MINUTES = 60;

/**
 * Whether a leaf state is a park — a hold only a human or a driver clears.
 *
 * `blocked` and the `human:*` family are exactly the states whose only exit is an `UNBLOCKED` event
 * somebody decides to record; sitting in one is the state working, not a stall. Deliberately NOT
 * every state that routes to no shell: `queued` also routes to none, and a queued lane nobody
 * dispatched is the silence this module exists to catch.
 */
export const isPark = (leaf: string): boolean => leaf === "blocked" || leaf.startsWith("human:");

/**
 * The active phase's per-task leaf states, read off the status the fold derived.
 *
 * The active phase is the one entry whose value is an object — the same structural recognition
 * `applyEvent` uses — because a future phase is the string `"waiting"` and a done workflow is a bare
 * terminal name.
 */
export const activeLeaves = (status: LaneStatus): ReadonlyArray<string> => {
	if (typeof status.stateValue === "string") return [];
	const leaves: string[] = [];
	for (const phase of Object.values(status.stateValue)) {
		if (typeof phase === "string") continue;
		leaves.push(...Object.values(phase));
	}
	return leaves;
};

export type Disposition = "terminal" | "parked" | "driven";

/** What a lane's folded state says about whether anything should be driving it. */
export const dispositionOf = (status: LaneStatus): Disposition => {
	if (status.status === "done") return "terminal";
	const leaves = activeLeaves(status);
	if (leaves.some((leaf) => shellState(leaf) !== null)) return "driven";
	return leaves.length > 0 && leaves.every(isPark) ? "parked" : "driven";
};

/**
 * The most recent event instant across a log, in epoch milliseconds.
 *
 * The maximum rather than the last line: the log is appended in order, but a hand edit or a clock
 * step can put an older `at` last, and taking the tail there would report a lane as older than it
 * is. `Unreadable` when entries exist and none of their `at` values parse — never folded into
 * "no events", because the two take opposite remedies (fix the log vs drive the lane).
 */
export type LastMoved =
	| {readonly _tag: "Moved"; readonly at: string; readonly epochMs: number}
	| {readonly _tag: "Never"}
	| {readonly _tag: "Unreadable"};

export const lastMoved = (ats: ReadonlyArray<string>): LastMoved => {
	if (ats.length === 0) return {_tag: "Never"};
	let best: {at: string; epochMs: number} | undefined;
	for (const at of ats) {
		const epochMs = Date.parse(at);
		if (Number.isNaN(epochMs)) continue;
		if (best === undefined || epochMs > best.epochMs) best = {at, epochMs};
	}
	return best === undefined ? {_tag: "Unreadable"} : {_tag: "Moved", ...best};
};

/**
 * A lane's verdict.
 *
 * `unstarted` and `unreadable` are their own seats rather than either edge of `stale`/`moving`: a
 * lane with no events has no age to judge, and one whose timestamps do not parse has an age nobody
 * can compute. Resolving either to "moving" would hide it, and to "stale" would invent a fact.
 */
export type Verdict = "stale" | "moving" | "parked" | "terminal" | "unstarted" | "unreadable";

export interface Judgement {
	readonly verdict: Verdict;
	/** Minutes since the lane's most recent event; `null` when there is no age to compute. */
	readonly ageMinutes: number | null;
	/** The `at` the age was measured from; `null` when the lane has never moved. */
	readonly lastEventAt: string | null;
}

/**
 * Judge one lane against the clock. `nowEpochMs` is the caller's, so the answer is a pure function
 * of its inputs and a test needs no fake timer.
 */
export const judge = (
	status: LaneStatus,
	moved: LastMoved,
	nowEpochMs: number,
	olderThanMinutes: number,
): Judgement => {
	const at = moved._tag === "Moved" ? moved.at : null;
	const disposition = dispositionOf(status);
	if (disposition !== "driven") {
		return {
			verdict: disposition === "terminal" ? "terminal" : "parked",
			ageMinutes: moved._tag === "Moved" ? ageInMinutes(moved.epochMs, nowEpochMs) : null,
			lastEventAt: at,
		};
	}
	if (moved._tag === "Never") return {verdict: "unstarted", ageMinutes: null, lastEventAt: null};
	if (moved._tag === "Unreadable") {
		return {verdict: "unreadable", ageMinutes: null, lastEventAt: null};
	}
	const ageMinutes = ageInMinutes(moved.epochMs, nowEpochMs);
	return {
		verdict: ageMinutes >= olderThanMinutes ? "stale" : "moving",
		ageMinutes,
		lastEventAt: at,
	};
};

/** Whole minutes between two instants, floored at zero — a clock that ran backwards is age 0. */
const ageInMinutes = (epochMs: number, nowEpochMs: number): number =>
	Math.max(0, Math.floor((nowEpochMs - epochMs) / 60_000));
