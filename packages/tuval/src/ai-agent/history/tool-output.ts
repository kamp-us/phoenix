/**
 * The per-item bound, applied where a raw backend result becomes a `ToolItem`.
 *
 * Same discipline as the window: cut, then say what the cut left out. It runs at the adapter edge
 * so that every item reaching the planners is already inside `TOOL_RESULT_BYTE_LIMIT` — which is
 * what keeps one runaway `cat` from spending the whole window's byte budget.
 */

import {
	boundToolResult,
	TOOL_RESULT_BYTE_LIMIT,
	type ToolItem,
	type TranscriptItem,
} from "../ports/index.ts";

/** A tool item as an adapter has it before the bound: the raw result text, not a `ToolResult`. */
export type RawToolItem = Omit<ToolItem, "result"> & {readonly output: string};

export const boundToolOutput = (
	item: RawToolItem,
	limit: number = TOOL_RESULT_BYTE_LIMIT,
): ToolItem => {
	const {output, ...rest} = item;
	return {...rest, result: boundToolResult(output, limit)};
};

/** Total bytes the per-item bound dropped across a slice — the loading row's own count. */
export const droppedResultBytes = (items: ReadonlyArray<TranscriptItem>): number =>
	items.reduce((total, item) => total + (item.kind === "tool" ? item.result.omitted.bytes : 0), 0);
