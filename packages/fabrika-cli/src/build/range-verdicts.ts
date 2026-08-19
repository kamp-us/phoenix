/**
 * Whether an epic child already carries a reviewed build — the fact the claim path could not see.
 *
 * An epic child opens no pull request (ADR 0285), so its review lands as range-bound comments on the
 * child issue itself (ADR 0276) — the one surface neither `build eligible` (which reads the
 * `blocked_by` graph) nor `build claim` (which reads claim markers) ever looked at. A child whose
 * newest verdict was `FAIL` therefore passed both gates and was handed to a fresh lane as ordinary
 * work, which built a second, independent implementation of a criterion the FAIL already named
 * (#6386, reproduced on #6296 and #6298).
 *
 * The fold is `lane prove`'s, deliberately: newest write stamp wins per namespace, so a `FAIL`
 * upserted after a `PASS` still wins (#4200). What it does **not** do is ask whether the claim still
 * binds. That question needs the range's content digest, which needs the child's branch in this tree
 * (`../lane/range.ts`), and a claim has no tree yet — but more than that, staleness is the wrong
 * question here. "Does this verdict still bind" is what a repair lane asks before it re-reviews;
 * "has this child been built and reviewed at all" is what a *fresh* claim asks, and a stale `FAIL`
 * answers that one yes.
 *
 * A comment reaching for the range format and missing it is counted, never dropped: a verdict posted
 * in a broken format is the one failure that would otherwise present as "the reviewer never ran".
 */

import type {CommentRecord} from "../io/issues.ts";
import type {Polarity} from "../wire/marker-line.ts";
import {read as readMarker, renderRange} from "../wire/range-verdict-marker.ts";

/** One namespace's newest range-scoped verdict claim on a child issue. */
export interface RangeVerdict {
	readonly namespace: string;
	readonly polarity: Polarity;
	readonly commentId: number;
	/** The `<base>..<tip>` the verdict was formed over, as the marker spells it. */
	readonly range: string;
}

/** What a child's comment thread says about it — the standing verdicts, and the markers that broke. */
export interface RangeVerdictRead {
	/** Newest-per-namespace, ordered by namespace so a refusal names them the same way every run. */
	readonly standing: ReadonlyArray<RangeVerdict>;
	/** `#<comment id>: <why>` per body that reaches for a range marker and is not one. */
	readonly malformed: ReadonlyArray<string>;
}

export const readRangeVerdicts = (comments: ReadonlyArray<CommentRecord>): RangeVerdictRead => {
	const latest = new Map<string, RangeVerdict>();
	const stamps = new Map<string, string>();
	const malformed: string[] = [];
	for (const comment of comments) {
		const parsed = readMarker(comment.body);
		if (parsed._tag === "Malformed") {
			malformed.push(`#${comment.id}: ${parsed.reason}`);
			continue;
		}
		if (parsed._tag !== "Found") continue;
		const marker = parsed.value;
		const seen = stamps.get(marker.namespace);
		if (seen !== undefined && seen > comment.updatedAt) continue;
		stamps.set(marker.namespace, comment.updatedAt);
		latest.set(marker.namespace, {
			namespace: marker.namespace,
			polarity: marker.polarity,
			commentId: comment.id,
			range: renderRange(marker.range),
		});
	}
	return {
		standing: [...latest.values()].sort((a, b) => a.namespace.localeCompare(b.namespace)),
		malformed,
	};
};

/** The standing verdicts a fresh build claim must not build over. */
export const failing = (read: RangeVerdictRead): ReadonlyArray<RangeVerdict> =>
	read.standing.filter((verdict) => verdict.polarity === "FAIL");
