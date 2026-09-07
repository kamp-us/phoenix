/**
 * Which board closures entitle a cancellation, and which send the reader somewhere else.
 *
 * The whole judgement `lane cancel` makes, held apart from the verb so it is testable without a
 * network, and reading no disk and no board of its own. The verb hands it what one issue read said;
 * this decides what that entitles.
 *
 * **Three answers, never two.** A not-planned or duplicate close is a cancellation. A completed
 * close is the shipped path's — the work landed, and recording it as cancelled would say the
 * opposite of what the board says. Anything else, including a read that failed, is UNKNOWN, and
 * UNKNOWN appends nothing: a cancellation is the one lane terminal with no artifact behind it, so
 * the board read IS its evidence, and folding a failed read into either arm invents the fact the
 * terminal is supposed to stand on.
 */

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

/** GitHub's `state_reason` for a close that shipped — the arm the shipped path owns. */
export const LANDED_OUTCOME = "completed";

/** What one board read of the driving issue entitles. */
export type Entitlement =
	/** The board proved a not-planned or duplicate close; `outcome` is the line's evidence. */
	| {readonly _tag: "Cancellable"; readonly outcome: CancellationOutcome}
	/** The issue is open: there is live work here, and no closure to stand on. */
	| {readonly _tag: "Live"}
	/** The issue closed with the work landed — `lane reconcile` then `lane archive`, not this. */
	| {readonly _tag: "Landed"}
	/** The board could not be read, or answered a closure nobody can classify. */
	| {readonly _tag: "Unknown"; readonly reason: string};

/**
 * What the board's answer about one issue entitles.
 *
 * `state` is the issue's `open`/`closed`, `reason` its `state_reason` — `null` where GitHub recorded
 * none, which is the shape a close predating `state_reason` has and is therefore UNKNOWN rather than
 * a not-planned close read generously.
 */
export const entitlement = (state: "open" | "closed", reason: string | null): Entitlement => {
	if (state === "open") return {_tag: "Live"};
	if (reason === null) {
		return {
			_tag: "Unknown",
			reason:
				"the board records no `state_reason` for this close, so whether the work landed or was dropped is UNKNOWN",
		};
	}
	if (reason === LANDED_OUTCOME) return {_tag: "Landed"};
	return isCancellationOutcome(reason)
		? {_tag: "Cancellable", outcome: reason}
		: {
				_tag: "Unknown",
				reason: `the board closed this issue as "${reason}", which is outside the outcomes a cancellation may stand on (${CANCELLATION_OUTCOME_TOKENS.join(", ")}) and is not "${LANDED_OUTCOME}"`,
			};
};
