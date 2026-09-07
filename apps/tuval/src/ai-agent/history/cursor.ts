import type {TranscriptItem} from "../ports/index.ts";

export type PageCursor =
	| {readonly kind: "page"; readonly before: string | null}
	| {readonly kind: "unavailable"};

const isLocal = (item: TranscriptItem): boolean =>
	(item.kind === "user" && item.local === true) || item.id.startsWith("local:");

/** Skip window-only echoes; backend projections join live ids to stored ids in the page planner. */
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
	if (!isLocal(item)) return {kind: "page", before};
	const backend = held.slice(index + 1).find((candidate) => !isLocal(candidate));
	return backend === undefined ? {kind: "unavailable"} : {kind: "page", before: backend.id};
};
