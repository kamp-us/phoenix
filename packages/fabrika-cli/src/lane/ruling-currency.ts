/**
 * Whether a verdict still grades the spec that now stands — the ruling half of verdict currency.
 *
 * A verdict binds a head and survives a head move through the content it bound
 * (`../wire/verdict-marker.ts`). Neither binding says anything about the *contract*: one lane's PR
 * carried two `PASS` verdicts, both SHA-current, both written before three founder rulings landed on
 * the issue — so the fold read two current passes and the repair builder correctly changed nothing.
 * A verdict written before the newest standing ruling graded a spec that has since moved, and this
 * is the one read that says so.
 *
 * **The comparison is the verdict's write stamp against the ruling's own stamp**, because that is
 * what both artifacts carry. A verdict's SHA has a commit date, but the date a reviewer *judged* is
 * when the comment was written, and a rebase would otherwise re-date every verdict on the PR.
 *
 * **Three answers, not a boolean.** A stamp that will not parse is `unknown`, never `current`:
 * calling an undatable verdict current is the fail-open direction, and it is the exact direction the
 * defect ran in.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9517#issuecomment-5752597880
 */

/** What a standing ruling says about one verdict's currency. */
export type RulingCurrency =
	/** No ruling stands, or the verdict was written after the newest one. */
	| "current"
	/** The verdict predates the newest standing ruling, so it graded a spec that has moved. */
	| "superseded"
	/** One of the two stamps did not read — never collapsed into `current`. */
	| "unknown";

const instant = (stamp: string): number | null => {
	const parsed = Date.parse(stamp);
	return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Judge one verdict's write stamp against the newest standing ruling on the issue it serves.
 *
 * `rulingAt` is `null` where nothing rules the issue, which is the ordinary case and answers
 * `current` — this read only ever subtracts.
 */
export const againstRuling = (verdictStamp: string, rulingAt: string | null): RulingCurrency => {
	if (rulingAt === null) return "current";
	const verdict = instant(verdictStamp);
	const ruling = instant(rulingAt);
	if (verdict === null || ruling === null) return "unknown";
	return verdict < ruling ? "superseded" : "current";
};
