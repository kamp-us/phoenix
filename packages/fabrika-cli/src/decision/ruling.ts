/**
 * What ruling already stands on a decision issue, and the target read both verbs share.
 *
 * Who *may* rule is `../ship/roster.ts` — one control-plane read, the same one `plan approve`
 * resolves, so this group cannot drift from the ACL the merge gate enforces.
 *
 * **Both sides resolve that roster, because a marker is bytes.** The write resolves it to decide
 * whether this invocation may post; the read resolves it again to decide whose posted bytes count.
 * Posting a `decision-ruled:` line takes nothing but the ability to comment on the issue, and the
 * digest it must carry is derivable by anyone who can read the body — so a read honouring the format
 * alone would let any agent token in this pipeline flip a decision to `ready-for:agent`, which is the
 * whole authority the marker is supposed to carry.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {DECISION_TYPE_LABEL} from "../build/scope-admission.ts";
import {type CommentRecord, getIssue, type IssueRecord} from "../io/issues.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {type DecisionRuling, read as readRuling, rules} from "../wire/decision-ruling.ts";
import {NO_TARGET, PRECONDITION_UNKNOWN} from "./codes.ts";

export type DecisionTarget =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Decision"; readonly issue: IssueRecord};

/**
 * The issue this group acts on, proven to be a decision issue before anything else runs.
 *
 * An unreadable issue is `11` and a proven non-decision is `7`; folding the two would let a 502 read
 * as "that is not a decision", which is the fail-open direction for an authority verb.
 */
export const requireDecision = (
	verb: string,
	repo: string,
	number: number,
): Effect.Effect<DecisionTarget, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getIssue(repo, number);
		if (found._tag === "Unknown") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read #${number}: ${found.reason} — nothing was written.`,
				),
			};
		}
		if (found._tag === "Absent") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(NO_TARGET, `${verb}: ${repo}#${number} does not exist.`),
			};
		}
		if (found.value.isPullRequest) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(NO_TARGET, `${verb}: ${repo}#${number} is a pull request, not an issue.`),
			};
		}
		if (!found.value.labels.includes(DECISION_TYPE_LABEL)) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					NO_TARGET,
					`${verb}: #${number} is not a ${DECISION_TYPE_LABEL} — refusing to record a ruling on it.`,
				),
			};
		}
		return {_tag: "Decision" as const, issue: found.value};
	});

/** The three states a decision's ruling resolves to. A fourth would have to be added here, in the open. */
export type RulingState = "current" | "stale" | "absent";

export interface StandingRuling {
	readonly ruling: DecisionRuling;
	readonly by: string;
	readonly comment: number;
}

export interface RulingScan {
	/** The newest conforming marker naming this issue, or `null` when none does. */
	readonly standing: StandingRuling | null;
	/**
	 * Comments that reach for the marker key and miss.
	 *
	 * Counted rather than dropped: a drifted marker is a *visible* state. Folding it into "nobody
	 * ruled" would tell a founder who did rule that he never did.
	 */
	readonly disregarded: number;
	/**
	 * Conforming markers naming this issue whose author is off the roster.
	 *
	 * Counted for the same reason, and it matters more: someone posted a ruling that does not count,
	 * and a scan that dropped it silently would report the issue as never ruled to the very account
	 * that tried.
	 */
	readonly unauthorized: number;
}

/**
 * The standing ruling among an issue's comments, newest last.
 *
 * `roster` is the read-time author gate — a marker from an account outside it is not a ruling,
 * however fresh its digest. Empty means nobody may rule here, so nothing stands.
 *
 * Ordered by `updatedAt` and then by id, never by `createdAt`: a marker edited after a later one was
 * posted is the newer statement, and only the write stamp says so (#4200).
 */
export const scanRulings = (
	comments: ReadonlyArray<CommentRecord>,
	issue: number,
	roster: ReadonlySet<string>,
): RulingScan => {
	const ordered = [...comments].sort((a, b) =>
		a.updatedAt === b.updatedAt ? a.id - b.id : a.updatedAt < b.updatedAt ? -1 : 1,
	);
	let standing: StandingRuling | null = null;
	let disregarded = 0;
	let unauthorized = 0;
	for (const comment of ordered) {
		const found = readRuling(comment.body);
		if (found._tag === "Malformed") {
			disregarded += 1;
			continue;
		}
		if (found._tag !== "Found" || found.value.issue !== issue) continue;
		if (!roster.has(comment.author)) {
			unauthorized += 1;
			continue;
		}
		standing = {ruling: found.value, by: comment.author, comment: comment.id};
	}
	return {standing, disregarded, unauthorized};
};

/** The state a scan resolves to against the digest derived from the body as it now stands. */
export const stateOf = (scan: RulingScan, issue: number, derived: string): RulingState => {
	if (scan.standing === null) return "absent";
	return rules(scan.standing.ruling, issue, derived) ? "current" : "stale";
};
