/**
 * How many repair rounds a PR has been through, counted by the heads its FAIL markers name.
 *
 * A round is one graded head, not one span of wall-clock time. Every gate writes the head SHA it
 * inspected into its marker, so every FAIL at one head is one round however far apart the gates
 * post, and the count moves only when a new head is pushed and graded.
 *
 * The rule used to be a 120-second cluster over `created_at`, which counted gate latency as repair
 * effort: two gates grading one head 8 minutes apart read as two rounds, so a PR burned its cap at
 * twice the real rate and escalated with rounds left (#6137, seen on #6122). #4570's inclusive-gap
 * boundary belonged to that rule and now governs only the head-less fallback below.
 *
 * Heads are matched the way a verdict is bound to one — `sameHead`'s prefix rule in
 * `../wire/marker-line.ts` — so an abbreviated SHA and the full SHA it abbreviates are one round.
 *
 * **A FAIL whose head is unreadable is counted, never dropped.** It cannot join a head's round, so
 * the head-less FAILs cluster among themselves by {@link ROUND_GAP_MS} and those clusters are added
 * to the head count. Under-counting here would hand a lane repair rounds nobody granted. A comment
 * whose marker does not parse at all is a different fact and stays out of the count: it is not a
 * proven FAIL, and the repair loop does not act on one either.
 */

import type {CommentRecord} from "../io/issues.ts";
import {type HeadSha, headSha, sameHead} from "../wire/marker-line.ts";
import {read as readMarker} from "../wire/verdict-marker.ts";

/** The gap at which a head-less FAIL still belongs to the round before it. Inclusive. */
export const ROUND_GAP_MS = 120_000;

/** One FAIL verdict as the counter reads it: the head it graded, and when it landed. */
export interface FailedHead {
	/** `null` when the marker named no readable head — the fallback below, never a dropped round. */
	readonly sha: string | null;
	readonly createdAt: string;
}

/** Cluster head-less FAIL timestamps by the inclusive 120-second gap. */
const timeClusters = (createdAt: ReadonlyArray<string>): number => {
	const times = createdAt
		.map((at) => Date.parse(at))
		.filter((ms) => !Number.isNaN(ms))
		.sort((a, b) => a - b);
	let clusters = 0;
	let previous: number | null = null;
	for (const ms of times) {
		if (previous === null || ms - previous > ROUND_GAP_MS) clusters += 1;
		previous = ms;
	}
	return clusters;
};

/**
 * Count the rounds a set of FAIL verdicts represents. No FAILs is zero rounds, which is a fact.
 *
 * Distinct heads are collected in encounter order against `sameHead`, so a 7-character SHA and the
 * 40-character one it abbreviates land in one round rather than in two.
 */
export const countRounds = (failed: ReadonlyArray<FailedHead>): number => {
	const heads: HeadSha[] = [];
	const headless: string[] = [];
	for (const fail of failed) {
		const sha = fail.sha === null ? null : headSha(fail.sha);
		if (sha === null) {
			headless.push(fail.createdAt);
			continue;
		}
		if (!heads.some((seen) => sameHead(seen, sha))) heads.push(sha);
	}
	return heads.length + timeClusters(headless);
};

/**
 * The round count of a PR, off its full comment set — the one derivation both call sites take.
 *
 * `build verdicts` and `build clear` judge the same budget, so both read the count through this
 * function rather than each folding the comments their own way. Two answers about one PR is how a
 * founder's cleared round gets stamped against a number the other reader does not hold (#6137).
 */
export const roundsOn = (comments: ReadonlyArray<CommentRecord>): number =>
	countRounds(
		comments.flatMap((comment) => {
			const parsed = readMarker(comment.body);
			return parsed._tag === "Found" && parsed.value.polarity === "FAIL"
				? [{sha: parsed.value.sha, createdAt: comment.createdAt}]
				: [];
		}),
	);
