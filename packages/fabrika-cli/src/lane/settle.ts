/**
 * Which board closures entitle which terminal, and which entitle none.
 *
 * The whole judgement `lane settle` makes, held apart from the verb so it is testable without a
 * network, and reading no disk and no board of its own. The verb hands it what one issue read and
 * one pull-request read said; this decides what those entitle.
 *
 * **Four answers, never two.** A not-planned or duplicate close is a cancellation. A completed close
 * whose issue is linked by at least one merged pull request is a landing — the work shipped outside
 * this lane's own flow, which is what a hand-shipped lane looks like. An open issue is live work.
 * Everything else, including a read that failed and a completed close with no merged linking PR, is
 * UNKNOWN, and UNKNOWN appends nothing: these two terminals are proven from nothing on disk, so the
 * board read IS their evidence, and folding a failed or empty read into either arm invents the fact
 * the terminal is supposed to stand on.
 *
 * **A caller may supply the link the body lacks, and never the merge.** Plenty of merged work cites
 * one issue in its body and closes another by hand, which leaves a lane whose landing is real and
 * unreadable. `--landed-by <pr>` names that merge; the board still has to say it merged, and the
 * line records that a caller asserted the link rather than a body proving it.
 */
import {CANCELLED_EVENT, LANDED_EVENT} from "./machine.ts";
import type {PullFact} from "./prove.ts";

/**
 * The closures a cancellation may stand on — GitHub's own `state_reason` spellings.
 *
 * `duplicate` is REST's value for a close-as-duplicate; `not_planned` covers wontfix, superseded and
 * every other "we are not doing this". The set is closed because the recorded `outcome` is what a
 * later reader audits the terminal by, and a spelling nobody defined audits nothing.
 */
export const CANCELLATION_OUTCOMES = {
	not_planned: "closed as not planned — wontfix, superseded, or otherwise not being done",
	duplicate: "closed as a duplicate of another issue",
} as const;

export type CancellationOutcome = keyof typeof CANCELLATION_OUTCOMES;

export const CANCELLATION_OUTCOME_TOKENS: ReadonlyArray<string> =
	Object.keys(CANCELLATION_OUTCOMES).sort();

const isCancellationOutcome = (token: string): token is CancellationOutcome =>
	Object.hasOwn(CANCELLATION_OUTCOMES, token);

/** GitHub's `state_reason` for a close that shipped — the landing arm's half of the entitlement. */
export const LANDED_OUTCOME = "completed";

/**
 * How a landing's link between the issue and its merge was established.
 *
 * A closed set of one, and the value is present only where the link was NOT read off a pull
 * request's body: `caller` says a human at the CLI named the merge with `--landed-by` because the
 * board holds no body linking it. A body-proven landing carries no `assertedBy` at all, so the
 * absent field is the stronger claim rather than the unstated one — which is what lets a later
 * reader audit the two apart without re-reading the board.
 */
export const ASSERTED_BY_CALLER = "caller";

/**
 * The pull request a caller named with `--landed-by`, as the board answered for it.
 *
 * Three answers, because the remedies differ: a merged one supplies the link the body lacks, an
 * unmerged one proves nothing yet and an absent one proves nothing ever. A read that FAILED is not
 * here at all — the verb refuses that as UNKNOWN before it gets this far, since a board it could not
 * read never entitles a terminal.
 */
export type AssertedPull =
	| {readonly _tag: "Merged"; readonly number: number; readonly sha: string | null}
	| {readonly _tag: "Unmerged"; readonly number: number; readonly state: string}
	| {readonly _tag: "Absent"; readonly number: number};

/** The merged pull requests whose body links this issue, through a closing keyword or `Part of`. */
export const mergedLinking = (
	issue: number,
	facts: ReadonlyArray<PullFact>,
): ReadonlyArray<PullFact> =>
	facts.filter((fact) => fact.merged && fact.linkedIssues.includes(issue));

/** What one board read of the driving issue, plus its candidate pull requests, entitles. */
export type Entitlement =
	/** The board proved a not-planned or duplicate close; nothing shipped, so there is no evidence. */
	| {readonly _tag: "Cancellable"; readonly event: string; readonly outcome: CancellationOutcome}
	/**
	 * The board proved a completed close AND at least one merged pull request linking the issue.
	 * `landed` is those pull requests' numbers — never empty, since an empty one is the `Unknown` arm.
	 */
	| {
			readonly _tag: "Landed";
			readonly event: string;
			readonly outcome: typeof LANDED_OUTCOME;
			readonly landed: ReadonlyArray<number>;
			/** {@link ASSERTED_BY_CALLER} where a caller supplied the link; absent where a body proved it. */
			readonly assertedBy?: typeof ASSERTED_BY_CALLER;
	  }
	/** `--landed-by` named a pull request the board does not hold: there is no merge to stand on. */
	| {readonly _tag: "AssertedAbsent"; readonly pr: number}
	/** `--landed-by` named a pull request that has not merged: the landing it asserts has not happened. */
	| {readonly _tag: "AssertedUnmerged"; readonly pr: number; readonly state: string}
	/** The issue is open: there is live work here, and no closure to stand on. */
	| {readonly _tag: "Live"}
	/** The board could not be read, or answered a closure nothing can classify. */
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * What the board's answer about one issue entitles.
 *
 * `state` is the issue's `open`/`closed` and `reason` its `state_reason` — `null` where GitHub
 * recorded none, which is the shape a close predating `state_reason` has and is therefore UNKNOWN
 * rather than a not-planned close read generously. `pulls` are the issue's candidate pull requests,
 * read only on the completed arm; the caller passes `null` where it did not read them. `asserted` is
 * the pull request `--landed-by` named, as the board answered for it, and `null` where no caller
 * named one.
 *
 * A completed close with no merged linking pull request and no assertion is UNKNOWN and not a
 * landing. The board says somebody called this done and names nothing that did it, so what
 * discharged the lane is genuinely unread — and a `LANDED` line's whole job is to name the merge it
 * stands on.
 *
 * **An assertion supplies the link, never the merge.** A body-proven landing is judged first and
 * wins, so `--landed-by` can only ever fill the gap a body left; and the merge it names still has to
 * be one the board says merged, which is why an unmerged or absent one refuses here rather than
 * lowering the bar. What the caller supplies is the one thing no board read can recover — that THIS
 * merge is what discharged THIS lane — and the line records that they supplied it.
 */
export const entitlement = (
	issue: number,
	state: "open" | "closed",
	reason: string | null,
	pulls: ReadonlyArray<PullFact> | null,
	asserted: AssertedPull | null = null,
): Entitlement => {
	if (state === "open") return {_tag: "Live"};
	if (reason === null) {
		return {
			_tag: "Unknown",
			reason:
				"the board records no `state_reason` for this close, so whether the work landed or was dropped is UNKNOWN",
		};
	}
	if (isCancellationOutcome(reason)) {
		return {_tag: "Cancellable", event: CANCELLED_EVENT, outcome: reason};
	}
	if (reason !== LANDED_OUTCOME) {
		return {
			_tag: "Unknown",
			reason: `the board closed this issue as "${reason}", which is outside the outcomes a lane may be settled on (${[...CANCELLATION_OUTCOME_TOKENS, LANDED_OUTCOME].join(", ")})`,
		};
	}
	if (pulls === null) {
		return {
			_tag: "Unknown",
			reason: `#${issue} closed as ${LANDED_OUTCOME} and its pull requests were not read, so what landed is UNKNOWN`,
		};
	}
	const landed = mergedLinking(issue, pulls);
	if (landed.length > 0) {
		return {
			_tag: "Landed",
			event: LANDED_EVENT,
			outcome: LANDED_OUTCOME,
			landed: landed.map((fact) => fact.number),
		};
	}
	if (asserted === null) {
		return {
			_tag: "Unknown",
			reason: `#${issue} closed as ${LANDED_OUTCOME} and the board names no merged pull request linking it, so nothing read proves what discharged this lane — pass --landed-by <pr> to name the merge yourself, which records the link as asserted`,
		};
	}
	if (asserted._tag === "Absent") {
		return {_tag: "AssertedAbsent", pr: asserted.number};
	}
	if (asserted._tag === "Unmerged") {
		return {_tag: "AssertedUnmerged", pr: asserted.number, state: asserted.state};
	}
	return {
		_tag: "Landed",
		event: LANDED_EVENT,
		outcome: LANDED_OUTCOME,
		landed: [asserted.number],
		assertedBy: ASSERTED_BY_CALLER,
	};
};
