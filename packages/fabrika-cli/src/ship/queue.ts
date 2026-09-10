/**
 * Reading queue state off the timeline, and reading a landing off the base branch.
 *
 * Two rules here are incident-shaped and neither is negotiable:
 *
 * - **An ejection is a removal NOT paired with a merge.** The queue consuming an entry emits the
 *   same `removed_from_merge_queue` event ≤1s before the merge, so reading the bare removal reports
 *   a false ejection over a PR that landed.
 * - **The base-branch subject match is anchored at the END.** A squashed subject can carry two
 *   parenthesised numbers, and the last one is the PR that landed; a contains-match credits the
 *   other. The timeline itself lags the truth by up to ~65 minutes, which is why the base branch is
 *   cross-checked at all.
 */
import type {TimelineEvent} from "./github.ts";

export const ADDED = "added_to_merge_queue";
export const REMOVED = "removed_from_merge_queue";
export const MERGED = "merged";

export type QueueState = "queued" | "ejected" | "none";

const PAIRING_WINDOW_MS = 5_000;

export const queueStateOf = (events: ReadonlyArray<TimelineEvent>): QueueState => {
	const added = events.filter((event) => event.event === ADDED);
	const removed = events.filter((event) => event.event === REMOVED);
	const merged = events.filter((event) => event.event === MERGED);

	const lastAdded = added.at(-1)?.createdAt ?? null;
	const lastRemoved = removed.at(-1)?.createdAt ?? null;
	if (lastAdded !== null && (lastRemoved === null || lastAdded > lastRemoved)) return "queued";
	if (lastRemoved === null) return "none";

	const removedAt = Date.parse(lastRemoved);
	const paired = merged.some((event) => {
		const mergedAt = Date.parse(event.createdAt);
		return (
			Number.isFinite(mergedAt) &&
			Number.isFinite(removedAt) &&
			Math.abs(mergedAt - removedAt) <= PAIRING_WINDOW_MS
		);
	});
	return paired ? "none" : "ejected";
};

/** A squash on the base branch whose subject ENDS with `(#<pr>)`. */
export const landedOnBase = (subjects: ReadonlyArray<string>, pr: number): boolean => {
	const anchor = `(#${pr})`;
	return subjects.some((message) => (message.split("\n")[0] ?? "").trimEnd().endsWith(anchor));
};

/** How many `reopened` events fall at or after a timestamp — the nudge's at-most-once proof. */
export const reopensSince = (events: ReadonlyArray<TimelineEvent>, since: string): number =>
	events.filter((event) => event.event === "reopened" && event.createdAt >= since).length;
