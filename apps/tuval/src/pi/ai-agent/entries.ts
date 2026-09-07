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
 * A `compaction` is the one entry that moved the transcript out from under the reader, so it gets
 * the port's own boundary kind; every other non-message entry — a branch summary, a model or
 * thinking-level change, an extension's own entry, a rename, a label — is one collapsed `system`
 * notice. The entry union is `SessionEntry` in `@earendil-works/pi-coding-agent`
 * `dist/core/session-manager.d.ts` at 0.84.3, and a kind outside it is skipped rather than thrown
 * on, so a session file a newer Pi wrote still opens.
 */

import {
	buildContextEntries,
	type CustomMessageEntry,
	type SessionEntry,
	type SessionMessageEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {TranscriptItem as PiTranscriptItem} from "@earendil-works/pi-protocol";
import {planTranscriptPage, type TranscriptPageResult} from "../../ai-agent/history/index.ts";
import type {SystemItem, TranscriptItem} from "../../ai-agent/ports/index.ts";
import {projectTranscript, type SourceMessage} from "../server/index.ts";
import {itemId, itemsOf, thinkingId} from "./items.ts";

/** An entry's ISO timestamp as epoch milliseconds; an unparseable one reads as the epoch. */
const millisOf = (timestamp: string): number => {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Re-key a projected item onto its entry. A tool row keeps the `toolCallId` `itemsOf` gave it —
 * that identity is what makes a later result supersede its running row — and everything else
 * takes the entry's own id, which is stable across the renumbering a compaction causes. A turn's
 * reasoning row is derived from that same entry id, so it stays distinct from the reply beside it.
 */
const onEntry = (item: TranscriptItem, entry: SessionMessageEntry): TranscriptItem => {
	const timestamp = millisOf(entry.timestamp);
	if (item.kind === "tool") return {...item, timestamp};
	const id = item.kind === "thinking" ? thinkingId(entry.id) : itemId(entry.id);
	return {...item, id, timestamp};
};

/** One collapsed notice: `text` is the line always shown, `detail` the body a window may fold. */
const noticeOf = (entry: SessionEntry, text: string, detail?: string): SystemItem => ({
	kind: "system",
	id: itemId(entry.id),
	timestamp: millisOf(entry.timestamp),
	text,
	...(detail === undefined || detail === "" ? {} : {detail}),
});

/** An extension's injected message as plain text; its `image` parts have no port field to land in. */
const contentText = (content: CustomMessageEntry["content"]): string =>
	typeof content === "string"
		? content
		: content.reduce((carried, part) => (part.type === "text" ? carried + part.text : carried), "");

/**
 * One non-message entry as the row the operator reads, or nothing when it is not the operator's to
 * see. `display: false` is an extension keeping its own message out of the transcript on purpose,
 * and the `default` arm is the entry kind this pin does not ship — skipped, never thrown on.
 */
const noticeItemOf = (entry: SessionEntry): TranscriptItem | null => {
	switch (entry.type) {
		case "compaction":
			return {
				kind: "compaction",
				id: itemId(entry.id),
				timestamp: millisOf(entry.timestamp),
				text: entry.summary,
			};
		case "branch_summary":
			return noticeOf(entry, entry.summary);
		case "model_change":
			return noticeOf(entry, `Model set to ${entry.provider}/${entry.modelId}`);
		case "thinking_level_change":
			return noticeOf(entry, `Thinking set to ${entry.thinkingLevel}`);
		case "session_info":
			return noticeOf(
				entry,
				entry.name === undefined ? "Session name cleared" : `Session named "${entry.name}"`,
			);
		case "label":
			return noticeOf(
				entry,
				entry.label === undefined ? "Label removed" : `Labelled "${entry.label}"`,
			);
		case "custom":
			return noticeOf(entry, `Extension entry: ${entry.customType}`);
		case "custom_message":
			return entry.display
				? noticeOf(entry, `Extension message: ${entry.customType}`, contentText(entry.content))
				: null;
		default:
			return null;
	}
};

/**
 * Live positions count context messages, not disk entries. Pi 0.84.3's `buildSessionContext`
 * composes these two exports, including compacted summaries and invisible custom messages.
 * Stored entry ids remain unchanged; only the page planner consumes these aliases.
 */
export const pageCursorAliases = (
	entries: ReadonlyArray<SessionEntry>,
): ReadonlyMap<string, string> => {
	const aliases = new Map<string, string>();
	let index = 0;
	for (const entry of buildContextEntries([...entries])) {
		const messages = sessionEntryToContextMessages(entry);
		if (entry.type === "message" && messages.length === 1) {
			aliases.set(`item-${index}`, entry.id);
			aliases.set(thinkingId(`item-${index}`), thinkingId(entry.id));
		}
		index += messages.length;
	}
	return aliases;
};

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
			if (source !== undefined)
				for (const item of itemsOf(source)) items.push(onEntry(item, entry));
			continue;
		}
		const notice = noticeItemOf(entry);
		if (notice !== null) items.push(notice);
	}
	return items;
};

/**
 * One page of this branch, planned the one way every caller must plan it.
 *
 * `cursorAliases` is what joins the window's live `item-<index>` cursor to the stored ids
 * `pageItems` keys by, and it is the whole of #8204's fix — so it lives here, where a test can
 * exercise the same construction the callers do, rather than being re-typed at each call site,
 * where dropping it reds nothing.
 */
export const planPageOverEntries = (
	entries: ReadonlyArray<SessionEntry>,
	bound: {readonly before: string | null; readonly limit: number},
): TranscriptPageResult =>
	planTranscriptPage(pageItems(entries), {
		before: bound.before,
		cursorAliases: pageCursorAliases(entries),
		limit: bound.limit,
		cursorBoundary: "containing-group",
	});
