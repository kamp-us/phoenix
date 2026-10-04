/**
 * The live read behind every "what rules this issue" question — one comment page, the roster only
 * where it can change the answer, and `./ruling.ts`'s scans over both.
 *
 * `../review/criteria-verb.ts` folds it into the graded set and `../lane/prove-verb.ts` dates a
 * verdict against it. Two callers, and a second reading of "who ruled" would be two gates
 * disagreeing about one comment — the shape this whole surface exists to retire. So the reads are
 * seated here and the scan is `./ruling.ts`'s.
 *
 * **The roster read is deferred on purpose, and the deferral is safe.** Resolving the control-plane
 * ACL costs a default-branch read, a CODEOWNERS read and a team expansion. It is paid only where it
 * can change the answer: a conforming marker is standing there, or some comment carries no machine
 * marker and so could be an owner's own words. An issue whose every comment is a machine marker
 * with no ruling among them reads no roster. A malformed marker is counted without one, because a
 * drifted marker is disregarded whoever wrote it.
 *
 * **Unreadable is its own answer and never an empty scan.** A roster that did not resolve says
 * nothing about whether anyone ruled, and a caller that read it as "nobody did" would grade a PR
 * against a spec a founder had already moved. The refusal seat is the caller's to pick, because the
 * two consumers owe different codes for the same fact.
 *
 * **The unmarked half never refuses, so it carries its own unknown.** With a marker standing, an
 * unresolved roster is the whole read's `Unknown`, as it always was. With none, the rulings half is
 * still proven empty — no roster can make a marker out of nothing — so the read stays `Scanned` and
 * only {@link UnmarkedRead} says the roster was not there to count against. Folding that into the
 * outer `Unknown` would turn a warning into a new refusal on every caller.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9517#issuecomment-5752597880
 * @ruling https://github.com/kamp-us/phoenix/issues/10309#issuecomment-5974136525
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type CommentRecord, listComments} from "../io/issues.ts";
import {controlPlaneRoster} from "../ship/roster.ts";
import {read as readRuling} from "../wire/decision-ruling.ts";
import {carriesMachineMarker} from "../wire/machine-marker.ts";
import {
	newestRulingAt,
	type RulingScan,
	scanRulings,
	type UnmarkedComment,
	unmarkedOwnerComments,
} from "./ruling.ts";

/** What the author gate resolved, or `null` where nothing on the issue made it worth resolving. */
export interface ResolvedRoster {
	readonly size: number;
	readonly owners: string;
	readonly ref: string;
}

/**
 * The roster comments no marker records, or the reason they could not be counted.
 *
 * `Unknown` is never an empty `Counted`: a roster that did not resolve says nothing about whether
 * an owner commented.
 */
export type UnmarkedRead =
	| {readonly _tag: "Unknown"; readonly reason: string}
	| {readonly _tag: "Counted"; readonly comments: ReadonlyArray<UnmarkedComment>};

export interface ScannedRulings {
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
	readonly unmarked: UnmarkedRead;
}

export type StandingRulingsRead =
	| {readonly _tag: "Unknown"; readonly reason: string}
	| ScannedRulings;

/** Whether any comment carries a marker this format reads — one of the roster read's two triggers. */
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
		const conforming = anyConforming(comments, issue);
		const unruled = (unmarked: UnmarkedRead): ScannedRulings => ({
			_tag: "Scanned",
			scan: scanRulings(comments, issue, new Set<string>()),
			comments,
			roster: null,
			unmarked,
		});
		if (!conforming && comments.every((comment) => carriesMachineMarker(comment.body))) {
			return unruled({_tag: "Counted", comments: []});
		}

		const roster = yield* controlPlaneRoster(repo);
		if (roster._tag === "Unknown") {
			return conforming
				? {
						_tag: "Unknown" as const,
						reason: `cannot read ${roster.reason} — who may rule is unread, so whether a ruling stands is UNKNOWN`,
					}
				: unruled({_tag: "Unknown", reason: `cannot read ${roster.reason}`});
		}
		const scan = scanRulings(comments, issue, roster.logins);
		return {
			_tag: "Scanned" as const,
			scan,
			comments,
			roster: {
				size: roster.logins.size,
				owners: roster.owners.join(", ") || "no owner",
				ref: roster.ref,
			},
			unmarked: {
				_tag: "Counted" as const,
				comments: unmarkedOwnerComments(comments, repo, issue, roster.logins, scan),
			},
		};
	});

/**
 * The stderr lines a caller prints for the unmarked half, empty when there is nothing to say.
 *
 * One renderer, so `review criteria` and `lane prove` cannot word one fact two ways.
 */
export const describeUnmarked = (
	verb: string,
	issue: number,
	read: ScannedRulings,
): ReadonlyArray<string> => {
	const {unmarked} = read;
	if (unmarked._tag === "Unknown") {
		return [
			`${verb}: ${unmarked.reason} — whether a control-plane account commented on #${issue} without a ruling marker is UNKNOWN, never zero. Read the issue's comments.`,
		];
	}
	if (unmarked.comments.length === 0) return [];
	const since =
		newestRulingAt(read.scan) === null
			? "carry no ruling marker"
			: "are newer than the newest standing ruling and carry no ruling marker";
	return [
		`${verb}: ${unmarked.comments.length} comment(s) by a control-plane account on #${issue} ${since}: ${unmarked.comments.map((comment) => comment.url).join(" ")}`,
		`${verb}: no gate grades those — read each one. Some may be agent prose posted under an owner's account; one that is a rule is recorded with \`fabrika decision rule ${issue} --cites <url>\`.`,
	];
};
