/**
 * The live read behind every "what rules this issue" question — one comment page, the roster only
 * where there is a marker to check against it, and `./ruling.ts`'s scan over both.
 *
 * `../review/criteria-verb.ts` folds it into the graded set and `../lane/prove-verb.ts` dates a
 * verdict against it. Two callers, and a second reading of "who ruled" would be two gates
 * disagreeing about one comment — the shape this whole surface exists to retire. So the reads are
 * seated here and the scan is `./ruling.ts`'s.
 *
 * **The roster read is deferred on purpose, and the deferral is safe.** Resolving the control-plane
 * ACL costs a default-branch read, a CODEOWNERS read and a team expansion, and on an issue no
 * comment of which even reaches for the marker key there is nothing to check against it. So the
 * comments are read first and the roster only when a conforming marker is standing there. A
 * malformed one is counted without it, because a drifted marker is disregarded whoever wrote it.
 *
 * **Unreadable is its own answer and never an empty scan.** A roster that did not resolve says
 * nothing about whether anyone ruled, and a caller that read it as "nobody did" would grade a PR
 * against a spec a founder had already moved. The refusal seat is the caller's to pick, because the
 * two consumers owe different codes for the same fact.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9517#issuecomment-5752597880
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments} from "../io/issues.ts";
import {controlPlaneRoster} from "../ship/roster.ts";
import {read as readRuling} from "../wire/decision-ruling.ts";
import {type RulingScan, scanRulings} from "./ruling.ts";

/** What the author gate resolved, or `null` where no marker made it worth resolving. */
export interface ResolvedRoster {
	readonly size: number;
	readonly owners: string;
	readonly ref: string;
}

export type StandingRulingsRead =
	| {readonly _tag: "Unknown"; readonly reason: string}
	| {
			readonly _tag: "Scanned";
			readonly scan: RulingScan;
			/**
			 * Every comment the scan walked.
			 *
			 * Carried rather than counted because a marker cites a comment *on this same issue*, so
			 * the founder's own words are already in this page — a caller that fetched them again
			 * would spend a round trip re-reading bytes it is holding.
			 */
			readonly comments: ReadonlyArray<CommentRecord>;
			readonly roster: ResolvedRoster | null;
	  };

/** Whether any comment carries a marker this format reads — the roster read's whole trigger. */
const anyConforming = (comments: ReadonlyArray<CommentRecord>, issue: number): boolean =>
	comments.some((comment) => {
		const found = readRuling(comment.body);
		return found._tag === "Found" && found.value.issue === issue;
	});

/** Every standing ruling on `issue`, author-gated against the live control-plane roster. */
export const standingRulings = (
	repo: string,
	issue: number,
): Effect.Effect<StandingRulingsRead, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const listed = yield* listComments(repo, issue);
		if (listed._tag === "Failure") {
			return {
				_tag: "Unknown" as const,
				reason: `cannot read the comments on #${issue}: ${listed.reason} — whether a ruling stands is UNKNOWN`,
			};
		}
		const comments = listed.value;
		if (!anyConforming(comments, issue)) {
			return {
				_tag: "Scanned" as const,
				scan: scanRulings(comments, issue, new Set<string>()),
				comments,
				roster: null,
			};
		}

		const roster = yield* controlPlaneRoster(repo);
		if (roster._tag === "Unknown") {
			return {
				_tag: "Unknown" as const,
				reason: `cannot read ${roster.reason} — who may rule is unread, so whether a ruling stands is UNKNOWN`,
			};
		}
		return {
			_tag: "Scanned" as const,
			scan: scanRulings(comments, issue, roster.logins),
			comments,
			roster: {
				size: roster.logins.size,
				owners: roster.owners.join(", ") || "no owner",
				ref: roster.ref,
			},
		};
	});
