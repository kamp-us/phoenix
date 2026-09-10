/**
 * The page bound: one older slice of history at a time, whole exchanges only, with the cursor for
 * the page older than it.
 *
 * History is backend-owned (#7569) — this is a pure bound over a slice the backend already
 * returned, never a store. Paging walks older, so a page carries its items oldest-first and its
 * `next` cursor names its own oldest item: the id the caller sends back as `before`. `next` is
 * `null` exactly when the supplied slice holds nothing older — whether the backend does is the
 * adapter's question, not this bound's.
 */

import type {TranscriptItem, TranscriptPagePayload} from "../ports/index.ts";
import {groupTranscript} from "./groups.ts";
import type {PlanRefusal} from "./refusal.ts";
import {
	boundaryOf,
	bytesOf,
	nestedLimitsFor,
	positiveLimit,
	TRANSCRIPT_WINDOW_BYTE_LIMIT,
	takeGroups,
} from "./window.ts";

export type TranscriptPage = Extract<TranscriptPagePayload, {kind: "page"}> & {
	/** Index of the page's oldest item in the slice it was planned over, oldest-first. */
	readonly start: number;
};

export type TranscriptPageResult = TranscriptPage | PlanRefusal;

export interface PageOptions {
	/** The oldest item the caller already holds, or `null` to start at the newest end. */
	readonly before?: string | null;
	/** Stored live items may sit inside an exchange whose prompt is held as a local echo. */
	readonly cursorBoundary?: "group-start" | "containing-group";
	/** Backend projection of live identities onto this stored history; stored ids take precedence. */
	readonly cursorAliases?: ReadonlyMap<string, string>;
	readonly limit: number;
	readonly byteLimit?: number;
}

/**
 * Plan the page immediately older than `before`.
 *
 * The limits round up to a whole group: a single exchange larger than `limit` is emitted whole
 * rather than split, because a page that could not carry it would return nothing and leave every
 * older item unreachable. The window's bounds are the hard ones; this one keeps history walkable.
 */
export const planTranscriptPage = (
	history: ReadonlyArray<TranscriptItem>,
	options: PageOptions,
): TranscriptPageResult => {
	const byteLimit = options.byteLimit ?? TRANSCRIPT_WINDOW_BYTE_LIMIT;
	const badLimit = positiveLimit(options.limit) ?? positiveLimit(byteLimit);
	if (badLimit !== null) return badLimit;

	const groups = groupTranscript(history);
	const requested = options.before ?? null;
	const cursor =
		requested === null || history.some((item) => item.id === requested)
			? requested
			: (options.cursorAliases?.get(requested) ?? requested);
	const containing =
		options.cursorBoundary === "containing-group" && cursor !== null
			? groups.find((group) => group.items.some((item) => item.id === cursor))
			: undefined;
	const boundary = boundaryOf(history, groups, containing?.items[0].id ?? cursor);
	if (typeof boundary !== "number") return boundary;

	const own = {items: options.limit, bytes: byteLimit};
	const taken = takeGroups(history, groups, boundary, {own, nested: nestedLimitsFor(own)});
	const older = history.slice(0, taken.start);
	return {
		kind: "page",
		start: taken.start,
		items: taken.items,
		omitted: {
			items: older.length + taken.shed.length,
			bytes: bytesOf(older) + bytesOf(taken.shed),
			reason: taken.reason,
		},
		next: older.length === 0 ? null : (taken.items[0]?.id ?? null),
	};
};
