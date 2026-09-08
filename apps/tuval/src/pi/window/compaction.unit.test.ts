import {
	buildContextEntries,
	type CompactionEntry,
	type SessionEntry,
	type SessionMessageEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {describe, expect, it} from "vitest";
import {groupTranscript} from "../../ai-agent/history/index.ts";
import {mergeOlder} from "../../shell/chat/rows.ts";
import {pageCursorAliases, pageItems, planPageOverEntries} from "../ai-agent/entries.ts";
import {emptyProjection, eventsOf, itemsOf} from "../ai-agent/items.ts";
import {projectTranscript, type SourceMessage} from "../server/transcript.ts";
import {
	createServerMessageDecoder,
	encodeServerMessage,
	type SessionSnapshot,
} from "../wire/index.ts";

const user = (id: string, parentId: string | null, text: string): SessionMessageEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-09-08T00:00:00.000Z",
	message: {role: "user", content: text, timestamp: 1},
});
const compact: CompactionEntry = {
	type: "compaction",
	id: "stored-boundary",
	parentId: "kept",
	timestamp: "2026-09-08T00:00:01.000Z",
	summary: "Earlier turns established the transcript paging contract.",
	firstKeptEntryId: "kept",
	tokensBefore: 4000,
};
const entries: ReadonlyArray<SessionEntry> = [
	user("old", null, "Older question"),
	user("kept", "old", "Keep this question"),
	compact,
	user("latest", compact.id, "Latest question"),
];

const decodedSnapshot = (): SessionSnapshot => {
	const messages = buildContextEntries([...entries]).flatMap(sessionEntryToContextMessages);
	const snapshot: SessionSnapshot = {
		id: "compaction-proof",
		cwd: "/workspace",
		createdAt: 0,
		updatedAt: 1,
		phase: "idle",
		model: {provider: "faux", id: "faux"},
		thinkingLevel: "off",
		attached: true,
		locked: false,
		revision: 1,
		transcript: [...projectTranscript(messages as ReadonlyArray<SourceMessage>)],
		queuedSteer: [],
		queuedSteerCount: 0,
	};
	const decoder = createServerMessageDecoder();
	const [decoded] = decoder.push(
		encodeServerMessage({type: "event", event: {type: "session_snapshot", snapshot}}),
	);
	decoder.end();
	if (decoded?.type !== "event" || decoded.event.type !== "session_snapshot") {
		throw new Error("Expected the compaction snapshot to survive the pinned codec");
	}
	return decoded.event.snapshot;
};

describe("Pi compaction through the live wire and stored history", () => {
	it("projects Pi's real context shape through the codec into a meaningful compaction event", () => {
		const snapshot = decodedSnapshot();
		const {events} = eventsOf(emptyProjection, snapshot);
		expect(events.filter((event) => event.kind === "item").map((event) => event.item)).toEqual([
			{
				kind: "compaction",
				id: "item-0:compaction",
				timestamp: Date.parse(compact.timestamp),
				text: compact.summary,
			},
			{kind: "user", id: "item-1", timestamp: 1, text: "Keep this question"},
			{kind: "user", id: "item-2", timestamp: 1, text: "Latest question"},
		]);
		expect(pageCursorAliases(entries).get("item-1")).toBe("kept");
		expect(pageCursorAliases(entries).get("item-2")).toBe("latest");
		expect(pageCursorAliases(entries).get("item-0:compaction")).toBe(compact.id);
	});

	it("keeps one boundary when its stored page overlaps the live tail, including repeated loads", () => {
		const tail = decodedSnapshot().transcript.flatMap(itemsOf);
		const page = planPageOverEntries(entries, {before: "item-2", limit: 50});
		if (page.kind !== "page") throw new Error("Expected stored history page");
		const stitched = mergeOlder(tail, page.items);
		expect(stitched.filter((item) => item.kind === "compaction")).toEqual([tail[0]]);
		expect(stitched.map((item) => item.id)).toContain("old");
		expect(mergeOlder(stitched, page.items)).toEqual(stitched);
		const stored = pageItems(entries);
		expect(stored.find((item) => item.kind === "compaction")?.alias).toBe("item-0:compaction");
		expect(
			groupTranscript(stored).some(
				(group) => group.items.length === 1 && group.items[0]?.kind === "compaction",
			),
		).toBe(true);
	});

	it("never interprets ordinary user text as a compaction carrier", () => {
		const messages: ReadonlyArray<SourceMessage> = [
			{role: "user", content: "item-0:compaction", timestamp: 1},
			{role: "user", content: compact.summary, timestamp: 2},
		];
		expect(
			projectTranscript(messages)
				.flatMap(itemsOf)
				.map((item) => [item.id, item.kind]),
		).toEqual([
			["item-0", "user"],
			["item-1", "user"],
		]);
	});
});
