import {isNestedItem, type TranscriptItem} from "../ports/index.ts";

export type PageCursor =
	| {readonly kind: "page"; readonly before: string | null}
	| {readonly kind: "unavailable"};

/**
 * Rows no backend's history read can resolve, so a cursor minted from one comes back
 * `cursor-not-found` and the window shows the unknown-cursor banner instead of a page (#8814).
 *
 * A `system` notice and a nested worker's row are live-only by construction: a stored session holds
 * the conversation's own turns, and neither class is one — the Claude CLI writes a worker's frames
 * to a `subagents/agent-*.jsonl` sidecar rather than the session file, and a task notice is minted
 * from an SDK notification that was never a message at all.
 *
 * The partial arm is read through `in` rather than off the assistant kind, for the reason
 * `../core/state.ts`'s `holdsPartialItem` is: reasoning grows a partial row of its own now (#8288),
 * and a third kind that grows one must not need this predicate edited to stay off the cursor.
 */
const isUnavailable = (item: TranscriptItem): boolean =>
	(item.kind === "user" && item.local === true) ||
	item.kind === "system" ||
	isNestedItem(item) ||
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
