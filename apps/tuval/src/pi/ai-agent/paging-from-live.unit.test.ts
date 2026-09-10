/**
 * The seam #8204 reported broken: a Pi window's live rows and its history page are built by two
 * different modules, and the window pages by sending a live row's own id back as the cursor.
 *
 * The two paths are joined here rather than in either module's own test, because neither of them
 * can see the mismatch alone. `items.ts` keys a live row `item-<index>` over the context messages
 * Pi's host projected; `entries.ts` keys the same message by its stored entry id, which is what
 * survives the renumbering a compaction causes. The join is `pageCursorAliases`, and it is
 * position-for-position with Pi's own context build — so the live tail here is projected the way
 * `../server/AgentSessionHost.ts` projects it (`buildContextEntries` → `sessionEntryToContextMessages`
 * → `projectTranscript`), never hand-numbered. Hand-numbering would pass while the real thing
 * failed, which is the whole bug.
 */

import type {CompactionEntry, SessionEntry} from "@earendil-works/pi-coding-agent";
import {buildContextEntries, sessionEntryToContextMessages} from "@earendil-works/pi-coding-agent";
import {describe, expect, it} from "vitest";
import {isRefusal} from "../../ai-agent/history/index.ts";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {projectTranscript, type SourceMessage} from "../server/index.ts";
import {pageItems, planPageOverEntries} from "./entries.ts";
import {itemsOf} from "./items.ts";

const at = (seconds: number): string => new Date(1_760_000_000_000 + seconds * 1_000).toISOString();

const message = (id: string, parent: string | null, seconds: number, body: unknown): SessionEntry =>
	({type: "message", id, parentId: parent, timestamp: at(seconds), message: body}) as SessionEntry;

const said = (text: string) => ({
	role: "user" as const,
	content: [{type: "text" as const, text}],
	timestamp: 0,
});

const replied = (text: string) => ({
	role: "assistant" as const,
	content: [{type: "text" as const, text}],
	provider: "faux",
	model: "faux-1",
	stopReason: "stop",
	timestamp: 0,
});

const called = (callId: string, name: string) => ({
	role: "assistant" as const,
	content: [{type: "toolCall" as const, id: callId, name, arguments: {path: "notes.md"}}],
	provider: "faux",
	model: "faux-1",
	stopReason: "toolUse",
	timestamp: 0,
});

const resulted = (callId: string, name: string, text: string) => ({
	role: "toolResult" as const,
	toolCallId: callId,
	toolName: name,
	content: [{type: "text" as const, text}],
	isError: false,
	timestamp: 0,
});

/** The rows the window's live tail holds, projected the way the real host projects them. */
const liveTail = (entries: ReadonlyArray<SessionEntry>): ReadonlyArray<TranscriptItem> => {
	const messages = buildContextEntries([...entries]).flatMap(
		sessionEntryToContextMessages,
	) as ReadonlyArray<SourceMessage>;
	return projectTranscript(messages).flatMap((item) => [...itemsOf(item)]);
};

/**
 * The `page` request, minus the disk read. It goes through `planPageOverEntries` — the same
 * function `PiAiAgent`'s `page` and `sessionTranscript` call — rather than re-typing the planner
 * options here, so removing the cursor alias from the shipped path reds this file (#8502 review).
 */
const pageBefore = (entries: ReadonlyArray<SessionEntry>, before: string | null, limit = 10) =>
	planPageOverEntries(entries, {before, limit});

const texts = (items: ReadonlyArray<TranscriptItem>): ReadonlyArray<string> =>
	items.map((item) => {
		if (item.kind === "user" || item.kind === "assistant") return item.text;
		if (item.kind === "tool") return `${item.name}()`;
		return item.kind;
	});

const plain: ReadonlyArray<SessionEntry> = [
	message("e1", null, 1, said("first question")),
	message("e2", "e1", 2, replied("first answer")),
	message("e3", "e2", 3, said("second question")),
	message("e4", "e3", 4, replied("second answer")),
	message("e5", "e4", 5, said("third question")),
	message("e6", "e5", 6, replied("third answer")),
];

describe("paging a Pi window back from its own live tail", () => {
	it("takes a live row's id as the cursor and answers with the exchange behind it", () => {
		const tail = liveTail(plain);
		expect(tail.map((item) => item.id)).toEqual([
			"item-0",
			"item-1",
			"item-2",
			"item-3",
			"item-4",
			"item-5",
		]);

		const planned = pageBefore(plain, tail[4]?.id ?? null);
		expect(isRefusal(planned)).toBe(false);
		if (isRefusal(planned)) return;
		expect(texts(planned.items)).toEqual([
			"first question",
			"first answer",
			"second question",
			"second answer",
		]);
	});

	it("hands back stored ids, so a second page walks off the first page's own oldest row", () => {
		const first = pageBefore(plain, liveTail(plain)[4]?.id ?? null, 2);
		expect(isRefusal(first)).toBe(false);
		if (isRefusal(first)) return;
		expect(texts(first.items)).toEqual(["second question", "second answer"]);

		const second = pageBefore(plain, first.items[0]?.id ?? null, 2);
		expect(isRefusal(second)).toBe(false);
		if (isRefusal(second)) return;
		expect(texts(second.items)).toEqual(["first question", "first answer"]);
	});

	// `mergeOlder`'s own join is `rows.unit.test.ts`'s; what it needs from this seam is that the
	// page and the tail never carry one turn twice — which they cannot be asked here by id, since
	// the two spaces are deliberately different. The turns themselves are the check.
	it("answers a page the live tail does not already hold, so a prepend doubles no turn", () => {
		const tail = liveTail(plain).slice(4);
		const planned = pageBefore(plain, tail[0]?.id ?? null);
		expect(isRefusal(planned)).toBe(false);
		if (isRefusal(planned)) return;
		expect([...texts(planned.items), ...texts(tail)]).toEqual([
			"first question",
			"first answer",
			"second question",
			"second answer",
			"third question",
			"third answer",
		]);
	});

	it("keys a tool row by its call on both paths, so a page joins the running row it replaced", () => {
		const withTool: ReadonlyArray<SessionEntry> = [
			...plain,
			message("e7", "e6", 7, said("fourth question")),
			message("e8", "e7", 8, called("call_notes", "read")),
			message("e9", "e8", 9, resulted("call_notes", "read", "the file body")),
			message("e10", "e9", 10, replied("fourth answer")),
		];
		const tail = liveTail(withTool);
		const tool = tail.find((item) => item.kind === "tool");
		expect(tool?.id).toBe("call_notes");
		expect(pageItems(withTool).find((item) => item.kind === "tool")?.id).toBe("call_notes");

		const planned = pageBefore(withTool, tool?.id ?? null, 2);
		expect(isRefusal(planned)).toBe(false);
		if (isRefusal(planned)) return;
		expect(texts(planned.items)).toEqual(["third question", "third answer"]);
	});

	it("keeps a loaded row's id still when a compaction renumbers the live tail under it", () => {
		const compaction: CompactionEntry = {
			type: "compaction",
			id: "compact",
			parentId: "e6",
			timestamp: at(7),
			summary: "the first two exchanges, summarized",
			firstKeptEntryId: "e5",
			tokensBefore: 4_000,
		};
		const compacted: ReadonlyArray<SessionEntry> = [
			...plain,
			compaction,
			message("e7", "compact", 8, said("fourth question")),
			message("e8", "e7", 9, replied("fourth answer")),
		];

		// The live space moved: the third exchange was `item-4`/`item-5` and is now `item-1`/`item-2`.
		expect(liveTail(compacted).map((item) => item.id)).toEqual([
			"item-0:compaction",
			"item-1",
			"item-2",
			"item-3",
			"item-4",
		]);
		// The stored space did not, so a page a window already holds still names the same rows.
		expect(pageItems(compacted).map((item) => item.id)).toEqual([
			"e1",
			"e2",
			"e3",
			"e4",
			"e5",
			"e6",
			"compact",
			"e7",
			"e8",
		]);

		const retainedUser = liveTail(compacted).find((item) => item.kind === "user");
		expect(retainedUser?.id).toBe("item-1");
		const planned = pageBefore(compacted, retainedUser?.id ?? null);
		expect(isRefusal(planned)).toBe(false);
		if (isRefusal(planned)) return;
		expect(texts(planned.items)).toEqual([
			"first question",
			"first answer",
			"second question",
			"second answer",
		]);
	});
});
