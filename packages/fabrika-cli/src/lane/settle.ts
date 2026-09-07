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
	  }
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
 * read only on the completed arm; the caller passes `null` where it did not read them.
 *
 * A completed close with no merged linking pull request is UNKNOWN and not a landing. The board says
 * somebody called this done and names nothing that did it, so what discharged the lane is genuinely
 * unread — and a `LANDED` line's whole job is to name the merge it stands on.
 */
export const entitlement = (
	issue: number,
	state: "open" | "closed",
	reason: string | null,
	pulls: ReadonlyArray<PullFact> | null,
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
	if (landed.length === 0) {
		return {
			_tag: "Unknown",
			reason: `#${issue} closed as ${LANDED_OUTCOME} and the board names no merged pull request linking it, so nothing read proves what discharged this lane`,
		};
	}
	return {
		_tag: "Landed",
		event: LANDED_EVENT,
		outcome: LANDED_OUTCOME,
		landed: landed.map((fact) => fact.number),
	};
};
