/**
 * Pi's JSONL session entries → the port item union, for the history `page` reads.
 *
 * History is backend-owned (founder ruling 5, #7569): older turns come back out of Pi's own
 * session file rather than a second copy Tuval keeps. `SessionManager.getBranch()`
 * (`@earendil-works/pi-coding-agent` `dist/core/session-manager.d.ts`) walks the current leaf to
 * the root and reverses, so its answer is already oldest-first — the order the page planner and
 * the window both want.
 *
 * The message projection is [`../server/transcript.ts`](../server/transcript.ts)'s
 * `projectTranscript`, reused rather than restated: the tool-input lookback it does (a tool result
 * names its call but not its arguments) is a whole-transcript pass, and a second hand-written
 * mapper would be a second place for that lookback to drift. Its ids are positional by its own
 * documented contract — `item-<index>` over the message list it was handed — which is what lets an
 * entry be matched back to its projected item here and re-keyed to the entry's own stable id.
 *
 * A `compaction` or `branch_summary` entry becomes a `system` item. Those are the only session
 * events the operator has to see to read the transcript honestly: a summary standing in for turns
 * that are no longer there.
 */

import type {SessionEntry} from "@earendil-works/pi-coding-agent";
import type {TranscriptItem as PiTranscriptItem} from "@earendil-works/pi-protocol";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {projectTranscript, type SourceMessage} from "../server/index.ts";
import {itemId, itemOf} from "./items.ts";

/** An entry's ISO timestamp as epoch milliseconds; an unparseable one reads as the epoch. */
const millisOf = (timestamp: string): number => {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Re-key a projected item onto its entry. A tool row keeps the `toolCallId` `itemOf` gave it —
 * that identity is what makes a later result supersede its running row — and everything else
 * takes the entry's own id, which is stable across the renumbering a compaction causes.
 */
const onEntry = (item: TranscriptItem, entry: SessionEntry): TranscriptItem =>
	item.kind === "tool"
		? {...item, timestamp: millisOf(entry.timestamp)}
		: {...item, id: itemId(entry.id), timestamp: millisOf(entry.timestamp)};

export const pageItems = (entries: ReadonlyArray<SessionEntry>): ReadonlyArray<TranscriptItem> => {
	const messages = entries.flatMap((entry) =>
		entry.type === "message" ? [entry.message as SourceMessage] : [],
	);
	const projected = new Map<string, PiTranscriptItem>(
		projectTranscript(messages).map((item) => [item.id, item]),
	);

	const items: Array<TranscriptItem> = [];
	let messageIndex = 0;
	for (const entry of entries) {
		if (entry.type === "message") {
			const source = projected.get(`item-${messageIndex}`);
			messageIndex += 1;
			// A message whose role the wire does not carry — an extension's own — projects to
			// nothing, and its index is spent all the same, which is why the counter advances first.
			if (source !== undefined) items.push(onEntry(itemOf(source), entry));
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			items.push({
				kind: "system",
				id: itemId(entry.id),
				timestamp: millisOf(entry.timestamp),
				text: entry.summary,
			});
		}
	}
	return items;
};
