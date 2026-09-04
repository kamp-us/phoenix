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
 *
 * A lane is nominated once. Whichever way the board answers, the verb appends the answer as a
 * correction, so the next sweep skips the line at either polarity and the population shrinks to the
 * lanes nobody has confirmed yet (ADR 0351).
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
 * A conservative upper bound on when `lane prove` began reading the ship stage's closure off the PR
 * the line names (#7457).
 *
 * ADR 0351 (#7800) taught the ship stage to record `partial: false` on a closing merge, so the line
 * would carry its own answer and a sweep would never buy that read twice. But until #7457 the
 * answer came out of the nominator, which cannot see the subject: a merged `Part of #N` is a node
 * in neither half of the union. So every `false` written in that window is the fallthrough wearing
 * an answer's clothes, and trusting it is the permissive fold this whole module undoes.
 *
 * A bound rather than the exact merge instant, because the instant is not knowable when the
 * constant is written. Erring late is the safe direction: a `false` needlessly re-read is paid
 * once — whichever way the board answers, the correction settles the line and the next sweep skips
 * it — while a `false` wrongly trusted leaves a lane folded to a terminal over an open issue, which
 * is the defect.
 */
const UNREAD_FALSE_BEFORE = "2026-09-06T00:00:00.000Z";

/** The key a correction names its target by — the pair {@link applyCorrections} matches on. */
const correctsKey = (task: string, at: string): string => `${task}\u0000${at}`;

/**
 * Whether this line's routing payload is still open — either it never carried one, or it carried an
 * unread `false` that no correction has settled yet.
 *
 * The second arm is what makes termination hold. A `false` is re-nominated at most once per line:
 * the sweep appends a correction whichever way the board answers, and the correction is what closes
 * the line — never the polarity it lands on, which would leave a confirmed-`false` line nominating
 * itself forever.
 */
const unanswered = (entry: LogEntry, corrected: ReadonlySet<string>): boolean => {
	if (entry.partial === undefined) return true;
	if (entry.partial) return false;
	return entry.at < UNREAD_FALSE_BEFORE && !corrected.has(correctsKey(entry.task, entry.at));
};

/**
 * The latest recorded event that reached a {@link CompiledLane} partial-guarded cell carrying no
 * answer its reader can trust.
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
	const corrected = new Set(
		entries.flatMap((entry) =>
			bareEvent(entry.event) === CORRECTED_EVENT && entry.corrects !== undefined
				? [correctsKey(entry.task, entry.corrects)]
				: [],
		),
	);
	let found: Misroute | null = null;
	for (const [index, entry] of log.entries()) {
		const task = lane.tasks[entry.task];
		if (task === undefined || !unanswered(entry, corrected)) continue;
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
 * this issue reaches the judgement. Both verbs land on it: `lane prove`'s ship stage reaches
 * `traceClosure` through `./closure.ts` and this function, never directly, so no caller reads that
 * permissive default raw (#7457).
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

/**
 * The line a read closure appends: it supersedes {@link Misroute} and moves no task.
 *
 * Both polarities are written, and the `false` one is the whole reason a sweep is affordable. A
 * proven-partial merge routes the lane round again; a proven-closing one changes nothing about where
 * the lane sits and is recorded anyway, so the confirmed read lives in the ledger and the next sweep
 * skips the lane instead of buying the same answer again (ADR 0351). The correction is the only
 * place that read can land — the ledger is the record, so there is no cache beside it.
 */
export const correctionEntry = (
	task: string,
	corrects: string,
	at: string,
	partial: boolean,
): LogEntry => ({
	task,
	event: `${task.toUpperCase()}.${CORRECTED_EVENT}`,
	at,
	partial,
	corrects,
});
