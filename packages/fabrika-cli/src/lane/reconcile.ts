/**
 * Which recorded line a lane's ledger got the merge closure wrong on, and the line that supersedes
 * it — the offline half of `lane reconcile` (ADR 0350).
 *
 * ADR 0343 taught the machine to send a merged `Part of #N` back to `queued`, but the routing fact
 * rides the recorded event as a `partial` payload, so a `DONE` written before that field existed
 * replays through the guard's fallthrough and still folds the lane to a terminal over an open,
 * buildable issue (#7433). The log is append-only and nothing may rewrite a recorded line, so the
 * repair is a `CORRECTED` line naming the one it supersedes.
 *
 * Reads no disk and no board: it answers which line is *correctable*, and whether the board agrees
 * the merge was partial is the verb's read, made only for a lane this module nominates.
 */
import {applyCorrections, foldLog, type LogEntry} from "./fold.ts";
import {bareEvent, CORRECTED_EVENT, type CompiledLane} from "./machine.ts";
import {type Closure, landedFor, type PullFact, traceClosure} from "./prove.ts";

export type Misroute =
	/** This entry sat on a partial-guarded cell and recorded no `partial` — the board decides. */
	| {
			readonly _tag: "Correctable";
			readonly task: string;
			readonly at: string;
			readonly state: string;
			readonly event: string;
			/**
			 * The pull request the line names as its own evidence, or `null` where it named none.
			 *
			 * The whole reason a reader need not nominate: the recorded terminal already says which
			 * merge it stands on, so what that merge closed is one read of one PR rather than a search
			 * over an issue's candidates — and a merged `Part of #N` is invisible to both nomination
			 * reads anyway, the closing edge carrying no `Part of` and the index searching open PRs
			 * only (#7433).
			 */
			readonly pr: string | null;
	  }
	/** No recorded line reads the guard, or every one that does already carries its answer. */
	| {readonly _tag: "Settled"; readonly why: string}
	| {readonly _tag: "Unreplayable"; readonly defects: ReadonlyArray<string>};

/**
 * The latest recorded event that took a {@link CompiledLane} partial-guarded cell's fallthrough for
 * want of a payload.
 *
 * Latest rather than every one, because a lane that merged partially, went round and merged again
 * has two such lines and only the last one still describes where the lane sits — correcting an
 * earlier one would re-route a round the lane has already walked past.
 *
 * The candidate is located off the compiled machine rather than off a state name: which state ships
 * and which event lands the merge is the document's call, so an epic tail's emitted region — which
 * declares no partial arm at all — nominates nothing here, exactly as ADR 0343 carves it out.
 */
export const findMisroute = (lane: CompiledLane, entries: ReadonlyArray<LogEntry>): Misroute => {
	const resolved = applyCorrections(entries);
	if (resolved._tag === "Undecidable") return {_tag: "Unreplayable", defects: resolved.defects};
	const log = resolved.entries;
	let found: Misroute | null = null;
	for (const [index, entry] of log.entries()) {
		const task = lane.tasks[entry.task];
		// Any recorded `partial` is the line's own answer, either polarity: this nominates a line that
		// recorded none, never one that recorded `false`, which would re-nominate the same corrected
		// line on every run forever.
		if (task === undefined || entry.partial !== undefined) continue;
		const before = foldLog(lane, log.slice(0, index));
		if (before._tag === "Unreplayable") return before;
		const state = before.states[entry.task];
		if (state === undefined) continue;
		if (task.partialStates.get(state.type)?.has(bareEvent(entry.event)) !== true) continue;
		found = {
			_tag: "Correctable",
			task: entry.task,
			at: entry.at,
			state: state.type,
			event: bareEvent(entry.event),
			pr: entry.pr ?? null,
		};
	}
	return (
		found ?? {
			_tag: "Settled",
			why: "no recorded event reached a merge-closure guard without carrying its answer",
		}
	);
};

/**
 * Whether this machine can express the question at all — whether any region declares a
 * `merge:partial` arm.
 *
 * A `Settled` answer means two different things and only this tells them apart: every recorded line
 * that reached the guard carries its answer, or the machine has no guard for one to reach. The
 * second is every lane booted before ADR 0343 shipped — lanes 6980 and 7382 among them — and
 * reading it as settled is the same permissive fold on one level up (#7433).
 */
export const declaresClosureGuard = (lane: CompiledLane): boolean =>
	Object.values(lane.tasks).some((task) => task.partialStates.size > 0);

/**
 * The pull request number a `pr` ref names, or `null` where the ref is not one this repo's verbs
 * wrote — a ref that names no PR is read as no evidence, never as a number to guess at.
 */
export const pullNumberIn = (ref: string | null): number | null => {
	const matched = ref === null ? null : /\/pull\/(\d+)(?:[/#?].*)?$/.exec(ref);
	return matched?.[1] === undefined ? null : Number(matched[1]);
};

export type ClosureRead =
	| {readonly _tag: "Read"; readonly closure: Closure}
	/**
	 * The board did not answer, or answered and proved nothing. Never read as `Closes` — that is the
	 * permissive fold #7433 exists to undo.
	 */
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * What a board answer *proves* about the merge behind a recorded terminal.
 *
 * {@link traceClosure} answers `Closes` when no merged PR links the issue, and that default is right
 * where it lives: refusing there would strand a shipper over a merge that really landed. Read here
 * it inverts. A `closes` verdict leaves the lane folded to its terminal, so a read that proved
 * nothing would be the justification for leaving alone exactly the lane this sweep exists to catch —
 * and that empty answer is the common case, not the rare one. The PR-less fallback lands on it by
 * construction, a merged `Part of #N` being invisible to both nomination reads; so does a named PR
 * that is not merged; so does one whose body carries both link kinds, since `issueRefsOf` drops
 * every `Part of` number when it does.
 *
 * So the absence of a closure proof is `Unknown`, and only a merged pull request that really links
 * this issue reaches the judgement. `lane prove`'s own use of `traceClosure` is untouched (#7457).
 */
export const provenClosure = (issue: number, facts: ReadonlyArray<PullFact>): ClosureRead => {
	const landed = landedFor(issue, facts);
	if (landed.length === 0) {
		return {
			_tag: "Unknown",
			reason: `the board named no merged pull request whose body links #${issue}, so nothing read proves this merge closed it`,
		};
	}
	return {_tag: "Read", closure: traceClosure(issue, landed)};
};

/** The line a proven-partial merge appends: it supersedes {@link Misroute} and moves no task. */
export const correctionEntry = (task: string, corrects: string, at: string): LogEntry => ({
	task,
	event: `${task.toUpperCase()}.${CORRECTED_EVENT}`,
	at,
	partial: true,
	corrects,
});
