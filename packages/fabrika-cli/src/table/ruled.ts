/**
 * The open issues a founder ruled on and nobody has built yet, oldest ruling first. `table prep`
 * lists them under Tails so each one gets a bet or a not-now instead of waiting to be picked.
 *
 * **The marker is the fact, not a label.** An issue counts as ruled only when a `decision-ruled`
 * marker naming it was posted by an account on the control-plane roster — the same scan
 * `decision ruling` answers from. A label anyone can add would say less than that.
 *
 * **Only decisions handed back to agents are read.** A ruled `type:decision` is the one issue a
 * ruling turns `ready-for:agent`, so that pair is the set whose comments are read. Reading every
 * open issue's comments each week would spend a large share of the hourly REST budget.
 *
 * A closed issue is never open, so a ruling whose build landed and closed the issue drops out.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9872#issuecomment-5852556900
 */

import {DECISION_TYPE_LABEL} from "../build/scope-admission.ts";
import {scanRulings} from "../decision/ruling.ts";
import type {CommentRecord, ListedIssue} from "../io/issues.ts";
import {READY_FOR_AGENT} from "../triage/audience.ts";
import type {MarkerTime, RulingUrl} from "../wire/decision-ruling.ts";

/** One open issue whose ruling is still waiting on a build. */
export interface RuledUnbuilt {
	readonly issue: number;
	/** When the issue was first ruled: how long the ruled work has waited. */
	readonly ruledAt: MarkerTime;
	/** The comment the newest standing ruling is written in. */
	readonly ruling: RulingUrl;
}

/** The open issues a ruling can be sitting on: decisions a ruling handed to agents. */
export const ruledSuspects = (open: ReadonlyMap<number, ListedIssue>): ReadonlyArray<number> =>
	[...open.values()]
		.filter(
			(issue) =>
				issue.labels.includes(DECISION_TYPE_LABEL) && issue.labels.includes(READY_FOR_AGENT),
		)
		.map((issue) => issue.number)
		.sort((a, b) => a - b);

const instant = (at: MarkerTime): number => Date.parse(at);

/**
 * Every issue among `reads` that carries a roster-authored ruling, oldest first ruling first and
 * then by number. An issue with no ruling from an account in `roster` is left out.
 */
export const ruledUnbuiltOf = (
	reads: ReadonlyArray<readonly [number, ReadonlyArray<CommentRecord>]>,
	roster: ReadonlySet<string>,
): ReadonlyArray<RuledUnbuilt> =>
	reads
		.flatMap(([issue, comments]): ReadonlyArray<RuledUnbuilt> => {
			const scan = scanRulings(comments, issue, roster);
			if (scan.standing === null) return [];
			const first = scan.all.reduce((earliest, one) =>
				instant(one.ruling.at) < instant(earliest.ruling.at) ? one : earliest,
			);
			return [{issue, ruledAt: first.ruling.at, ruling: scan.standing.ruling.ruling}];
		})
		.sort((a, b) => instant(a.ruledAt) - instant(b.ruledAt) || a.issue - b.issue);
