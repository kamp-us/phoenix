/**
 * Pi's JSONL entries → the port items `page` walks. Built entries, because the shapes that matter
 * here — a compaction standing in for turns that are gone, an extension's own message the wire does
 * not carry, a label — are ones a faux session will not produce on demand. Each is typed as the
 * entry interface `@earendil-works/pi-coding-agent` declares for it, so a field this pin renamed
 * reds here rather than passing as an envelope nobody checks. The two entries a real session does
 * write unprompted — the opening model and thinking-level changes — are read off one in
 * `pi-ai-agent.integration.test.ts`.
 */

import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionInfoEntry,
	ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";
import {buildContextEntries, sessionEntryToContextMessages} from "@earendil-works/pi-coding-agent";
import {describe, expect, it} from "vitest";
import {projectTranscript, type SourceMessage} from "../server/index.ts";
import {pageCursorAliases, pageItems} from "./entries.ts";
import {itemsOf} from "./items.ts";

/** The package's root does not re-export the label entry's interface; the union still names it. */
type LabelEntry = Extract<SessionEntry, {type: "label"}>;

const at = (seconds: number): string => new Date(1_760_000_000_000 + seconds * 1_000).toISOString();

const message = (id: string, parent: string | null, seconds: number, body: unknown): SessionEntry =>
	({
		type: "message",
		id,
		parentId: parent,
		timestamp: at(seconds),
		message: body,
	}) as SessionEntry;

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

describe("a session branch as pageable history", () => {
	it("keys each item by its entry and reads the entry's clock", () => {
		const items = pageItems([
			message("e1", null, 1, said("older question")),
			message("e2", "e1", 2, replied("older answer")),
		]);
		expect(items).toEqual([
			{
				kind: "user",
				id: "e1",
				alias: "item-0",
				timestamp: Date.parse(at(1)),
				text: "older question",
			},
			{
				kind: "assistant",
				id: "e2",
				alias: "item-1",
				timestamp: Date.parse(at(2)),
				text: "older answer",
			},
		]);
	});

	it("aliases live positions using Pi's compacted context, not the full stored branch", () => {
		const compaction: CompactionEntry = {
			type: "compaction",
			id: "compact",
			parentId: "a2",
			timestamp: at(5),
			summary: "older exchange summarized",
			firstKeptEntryId: "u2",
			tokensBefore: 4_000,
		};
		const custom: CustomMessageEntry = {
			type: "custom_message",
			id: "custom",
			parentId: "compact",
			timestamp: at(6),
			customType: "extension",
			content: "hidden context",
			display: false,
		};
		const entries = [
			message("u1", null, 1, said("old")),
			message("a1", "u1", 2, replied("old answer")),
			message("u2", "a1", 3, said("kept")),
			message("a2", "u2", 4, replied("kept answer")),
			compaction,
			custom,
			message("u3", "custom", 7, said("latest")),
			message("a3", "u3", 8, replied("latest answer")),
		];
		const aliases = pageCursorAliases(entries);
		expect(aliases.get("item-0")).toBeUndefined();
		expect(aliases.get("item-1")).toBe("u2");
		expect(aliases.get("item-2")).toBe("a2");
		expect(aliases.get("item-3")).toBeUndefined();
		expect(aliases.get("item-4")).toBe("u3");
		expect(aliases.get("item-5")).toBe("a3");
		expect(aliases.get("item-5:thinking")).toBe("a3:thinking");
		expect(aliases.get("item-6")).toBeUndefined();
		expect(pageItems(entries).map((item) => item.id)).toEqual([
			"u1",
			"a1",
			"u2",
			"a2",
			"compact",
			"u3",
			"a3",
		]);
	});

	it("carries a tool call's arguments onto the result that names it", () => {
		const items = pageItems([
			message("e1", null, 1, said("read it")),
			message("e2", "e1", 2, {
				role: "assistant",
				content: [{type: "toolCall", id: "call-1", name: "read_file", arguments: {path: "a.md"}}],
				provider: "faux",
				model: "faux-1",
				stopReason: "toolUse",
				timestamp: 0,
			}),
			message("e3", "e2", 3, {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read_file",
				content: [{type: "text", text: "file body"}],
				isError: false,
				timestamp: 0,
			}),
		]);
		const tool = items.at(-1);
		expect(tool).toEqual({
			kind: "tool",
			id: "call-1",
			timestamp: Date.parse(at(3)),
			name: "read_file",
			input: {path: "a.md"},
			result: {text: "file body", omitted: {bytes: 0}},
			status: "ok",
		});
	});

	it("renders a compaction as the boundary the turns it replaced went behind", () => {
		const compaction: CompactionEntry = {
			type: "compaction",
			id: "e1",
			parentId: null,
			timestamp: at(1),
			summary: "we agreed on the plan",
			firstKeptEntryId: "e0",
			tokensBefore: 4_000,
		};
		const items = pageItems([compaction, message("e2", "e1", 2, said("carry on"))]);
		expect(items).toEqual([
			{kind: "compaction", id: "e1", timestamp: Date.parse(at(1)), text: "we agreed on the plan"},
			{kind: "user", id: "e2", alias: "item-1", timestamp: Date.parse(at(2)), text: "carry on"},
		]);
	});

	it("keeps a branch summary a system note — it is about the session, not a context boundary", () => {
		const summary: BranchSummaryEntry = {
			type: "branch_summary",
			id: "e1",
			parentId: null,
			timestamp: at(1),
			fromId: "e0",
			summary: "the branch went nowhere",
		};
		expect(pageItems([summary])).toEqual([
			{kind: "system", id: "e1", timestamp: Date.parse(at(1)), text: "the branch went nowhere"},
		]);
	});

	it("carries an assistant turn's reasoning as its own row beside the reply", () => {
		const items = pageItems([
			message("e1", null, 1, said("think first")),
			message("e2", "e1", 2, {
				role: "assistant",
				content: [
					{type: "thinking", thinking: "weighing it up"},
					{type: "text", text: "here is the answer"},
				],
				provider: "faux",
				model: "faux-1",
				stopReason: "stop",
				timestamp: 0,
			}),
		]);
		expect(items.slice(1)).toEqual([
			{
				kind: "thinking",
				id: "e2:thinking",
				alias: "item-1:thinking",
				timestamp: Date.parse(at(2)),
				text: "weighing it up",
			},
			{
				kind: "assistant",
				id: "e2",
				alias: "item-1",
				timestamp: Date.parse(at(2)),
				text: "here is the answer",
			},
		]);
	});

	it("skips a message the wire does not carry without shifting the entries after it", () => {
		const items = pageItems([
			message("e1", null, 1, {role: "extension-only", content: [], timestamp: 0}),
			message("e2", "e1", 2, said("still mine")),
		]);
		expect(items).toEqual([
			{kind: "user", id: "e2", alias: "item-1", timestamp: Date.parse(at(2)), text: "still mine"},
		]);
	});
});

describe("the session's own entries as collapsed notices", () => {
	const base = {id: "e1", parentId: null, timestamp: at(1)} as const;

	const modelChange: ModelChangeEntry = {
		...base,
		type: "model_change",
		provider: "faux",
		modelId: "faux-1",
	};
	const thinkingChange: ThinkingLevelChangeEntry = {
		...base,
		type: "thinking_level_change",
		thinkingLevel: "high",
	};
	const custom: CustomEntry = {...base, type: "custom", customType: "notes", data: {kept: true}};
	const named: SessionInfoEntry = {...base, type: "session_info", name: "the Pi lane"};
	const unnamed: SessionInfoEntry = {...base, type: "session_info"};
	const labelled: LabelEntry = {...base, type: "label", targetId: "e0", label: "read this again"};
	const unlabelled: LabelEntry = {...base, type: "label", targetId: "e0", label: undefined};

	const lineOf = (entry: SessionEntry): string | null => {
		const item = pageItems([entry]).at(0);
		return item !== undefined && item.kind === "system" ? item.text : null;
	};

	it("gives every kind it used to skip a line of its own", () => {
		expect(
			[modelChange, thinkingChange, custom, named, unnamed, labelled, unlabelled].map(lineOf),
		).toEqual([
			"Model set to faux/faux-1",
			"Thinking set to high",
			"Extension entry: notes",
			'Session named "the Pi lane"',
			"Session name cleared",
			'Labelled "read this again"',
			"Label removed",
		]);
	});

	it("folds an extension's injected message body into the notice's detail", () => {
		const injected: CustomMessageEntry = {
			...base,
			type: "custom_message",
			customType: "recap",
			content: [{type: "text", text: "what happened last week"}],
			display: true,
		};
		expect(pageItems([injected])).toEqual([
			{
				kind: "system",
				id: "e1",
				timestamp: Date.parse(at(1)),
				text: "Extension message: recap",
				detail: "what happened last week",
			},
		]);
	});

	it("keeps an extension's hidden message out of the transcript it asked to stay out of", () => {
		const hidden: CustomMessageEntry = {
			...base,
			type: "custom_message",
			customType: "recap",
			content: "state nobody reads",
			display: false,
		};
		expect(pageItems([hidden])).toEqual([]);
	});

	/**
	 * The one case no typed value can state: an entry kind newer than this pin, read the way it would
	 * really arrive — a line parsed out of the session file. A file a later Pi wrote has to open, so
	 * the fold skips what it cannot read instead of throwing the page away.
	 */
	it("skips an entry kind this pin does not ship without taking the page down", () => {
		const laterPi = JSON.parse(
			`{"type":"kind_from_a_later_pi","id":"e1","parentId":null,"timestamp":"${at(1)}"}`,
		) as SessionEntry;
		const page = [laterPi, message("e2", "e1", 2, said("still here"))];
		expect(() => pageItems(page)).not.toThrow();
		expect(pageItems(page)).toEqual([
			{kind: "user", id: "e2", alias: "item-0", timestamp: Date.parse(at(2)), text: "still here"},
		]);
	});
});

/**
 * The two id spaces one Pi turn lives in. The live tail is built the way the host builds it
 * (`../server/AgentSessionHost.ts`: `buildContextEntries` → `sessionEntryToContextMessages` →
 * `projectTranscript`) rather than hand-numbered, because hand-numbered positions would agree with
 * `alias` by construction and prove nothing about the path the window actually renders.
 */
describe("the live id a stored row is also known by", () => {
	const liveIds = (entries: ReadonlyArray<SessionEntry>): ReadonlyArray<string> => {
		const messages = buildContextEntries([...entries]).flatMap(
			sessionEntryToContextMessages,
		) as ReadonlyArray<SourceMessage>;
		return projectTranscript(messages).flatMap((item) =>
			itemsOf(item).map((row) => String(row.id)),
		);
	};

	it("gives a stored user turn the id the live tail keys the same turn by", () => {
		const entries = [
			message("e1", null, 1, said("first question")),
			message("e2", "e1", 2, replied("first answer")),
		];
		expect(liveIds(entries)).toEqual(["item-0", "item-1"]);
		expect(pageItems(entries).map((item) => [item.id, item.alias])).toEqual([
			["e1", "item-0"],
			["e2", "item-1"],
		]);
	});

	it("gives an assistant turn's reasoning row its own live id, not the reply's", () => {
		const entries = [
			message("e1", null, 1, said("think first")),
			message("e2", "e1", 2, {
				role: "assistant",
				content: [
					{type: "thinking", thinking: "weighing it up"},
					{type: "text", text: "here is the answer"},
				],
				provider: "faux",
				model: "faux-1",
				stopReason: "stop",
				timestamp: 0,
			}),
		];
		expect(liveIds(entries)).toEqual(["item-0", "item-1:thinking", "item-1"]);
		expect(pageItems(entries).map((item) => [item.id, item.alias])).toEqual([
			["e1", "item-0"],
			["e2:thinking", "item-1:thinking"],
			["e2", "item-1"],
		]);
	});

	it("follows the renumbering a compaction causes rather than the stored order", () => {
		const compaction: CompactionEntry = {
			type: "compaction",
			id: "compact",
			parentId: "e4",
			timestamp: at(5),
			summary: "the first exchange, summarized",
			firstKeptEntryId: "e3",
			tokensBefore: 4_000,
		};
		const entries = [
			message("e1", null, 1, said("first question")),
			message("e2", "e1", 2, replied("first answer")),
			message("e3", "e2", 3, said("second question")),
			message("e4", "e3", 4, replied("second answer")),
			compaction,
			message("e5", "compact", 6, said("third question")),
		];
		// The stored order is untouched; the live tail starts at the summary the compaction left.
		expect(pageItems(entries).map((item) => [item.id, item.alias])).toEqual([
			["e1", undefined],
			["e2", undefined],
			["e3", "item-1"],
			["e4", "item-2"],
			["compact", undefined],
			["e5", "item-3"],
		]);
		expect(liveIds(entries)).toEqual(["item-1", "item-2", "item-3"]);
	});

	it("leaves a tool row unaliased — its call id is the same string on both paths", () => {
		const entries = [
			message("e1", null, 1, said("read it")),
			message("e2", "e1", 2, {
				role: "assistant",
				content: [{type: "toolCall", id: "call-1", name: "read_file", arguments: {path: "a.md"}}],
				provider: "faux",
				model: "faux-1",
				stopReason: "toolUse",
				timestamp: 0,
			}),
			message("e3", "e2", 3, {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read_file",
				content: [{type: "text", text: "file body"}],
				isError: false,
				timestamp: 0,
			}),
		];
		const tool = pageItems(entries).at(-1);
		expect(tool?.id).toBe("call-1");
		expect(tool?.alias).toBeUndefined();
		expect(liveIds(entries)).toContain("call-1");
	});
});
