import type {TranscriptItem} from "../ports/index.ts";

export type PageCursor =
	| {readonly kind: "page"; readonly before: string | null}
	| {readonly kind: "unavailable"};

// The partial arm is read through `in` rather than off the assistant kind, for the reason
// `../core/state.ts`'s `holdsPartialItem` is: reasoning grows a partial row of its own now (#8288),
// and a third kind that grows one must not need this predicate edited to stay off the cursor.
const isUnavailable = (item: TranscriptItem): boolean =>
	(item.kind === "user" && item.local === true) ||
	item.id.startsWith("local:") ||
	("partial" in item && item.partial === true);

/** Live partial text need not have a stored frame yet; aliases only join completed rows. */
export const pageCursor = (
	held: ReadonlyArray<TranscriptItem>,
	before: string | null,
): PageCursor => {
	if (before === null) return {kind: "page", before};
	const index = held.findIndex((item) => item.id === before);
	const item = held[index];
	// Older pages belong to the window, not the session tail. Their stored ids pass through.
	if (item === undefined) {
		return before.startsWith("local:") ? {kind: "unavailable"} : {kind: "page", before};
	}
	if (!isUnavailable(item)) return {kind: "page", before};
	const backend = held.slice(index + 1).find((candidate) => !isUnavailable(candidate));
	return backend === undefined ? {kind: "unavailable"} : {kind: "page", before: backend.id};
};
