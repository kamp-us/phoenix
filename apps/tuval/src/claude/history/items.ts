/**
 * `toHistoryItems` — a stored session's rows to the settled transcript a page renders.
 *
 * The rows are what `getSessionMessages` returns, and they are a different wire form from the live
 * stream: no `result` frame, no `init`, and `message` typed `unknown` (`sdk.d.ts`,
 * `SessionMessage`). What they share with the stream is the conversation itself, so the same
 * handlers read both and the difference lives only in this dispatch.
 *
 * The fold is what settles a tool row: the `tool_use` opens it `running` and its `tool_result`
 * re-sends the same id `ok` or `error`, so keeping the newest value per id at the position the id
 * first appeared leaves one settled row where the call was made.
 */

import type {SessionMessage} from "@anthropic-ai/claude-agent-sdk";
import type {ItemId, TranscriptItem} from "../../ai-agent/ports/index.ts";
import {
	assistantEvents,
	emptyMapping,
	type Mapping,
	type MappingOptions,
	type MappingStep,
	skipMessage,
	userEvents,
} from "./map.ts";

const rowEvents = (row: SessionMessage, mapping: Mapping, options: MappingOptions): MappingStep => {
	switch (row.type) {
		case "assistant":
			return assistantEvents(row, mapping, options);
		case "user":
			return userEvents(row, mapping, options);
		default:
			return skipMessage(mapping);
	}
};

export interface HistoryItems {
	readonly items: ReadonlyArray<TranscriptItem>;
	/** How many rows this mapping had nothing to say about. */
	readonly skipped: number;
}

export const toHistoryItems = (
	rows: ReadonlyArray<SessionMessage>,
	options: MappingOptions,
): HistoryItems => {
	const settled = new Map<ItemId, TranscriptItem>();
	let mapping = emptyMapping;
	for (const row of rows) {
		const step = rowEvents(row, mapping, options);
		mapping = step.mapping;
		for (const event of step.events) {
			if (event.kind === "item") settled.set(event.item.id, event.item);
		}
	}
	return {items: [...settled.values()], skipped: mapping.skipped};
};
