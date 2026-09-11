/**
 * The agy transcript reader, over captured v1.1.27 `transcript.jsonl` lines and real files on a
 * temporary disk.
 *
 * **Nothing here treats the observed `source`/`type` set as closed.** The census behind
 * `transcript-wire.ts` found three combinations the epic's own spec does not name, on a file format
 * with no version field — so every case below is a claim about the value it names, and the
 * unrecognised-combination case is the proof that the set staying open costs nothing.
 */

import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {Effect} from "effect";
import {afterAll, describe, expect, it} from "vitest";
import {isRefusal, type TranscriptPage} from "../../ai-agent/history/index.ts";
import {
	boundToolResult,
	isTranscriptItems,
	TOOL_RESULT_BYTE_LIMIT,
	type ToolItem,
	type TranscriptItem,
} from "../../ai-agent/ports/index.ts";
import {
	CLIPPED_MARK,
	readTranscriptPage,
	TRANSCRIPT_FILE,
	TRANSCRIPT_FULL_FILE,
	transcriptItems,
	transcriptLines,
	transcriptLogDir,
} from "./transcript.ts";
import * as fixtures from "./transcript-fixtures.ts";

const CID = fixtures.conversationId;

/** Raw file text → items, so every case runs the decode, the pairing and the ordering together. */
const itemsOf = (lines: ReadonlyArray<string>, full?: ReadonlyArray<string>) => {
	const items = transcriptItems(
		CID,
		transcriptLines(lines.join("\n")),
		transcriptLines((full ?? []).join("\n")),
	);
	expect(isTranscriptItems(items)).toBe(true);
	return items;
};

const kinds = (items: ReadonlyArray<TranscriptItem>) => items.map((item) => item.kind);
const texts = (items: ReadonlyArray<TranscriptItem>) =>
	items.map((item) => (item.kind === "tool" ? item.result.text : item.text));

/** The driven v1.1.28 capture, read through the reader exactly as it sits on disk. */
const capturedMultiCall = (): ReadonlyArray<TranscriptItem> => {
	const items = transcriptItems(
		fixtures.multiCallConversationId,
		transcriptLines(fixtures.multiCallLines.join("\n")),
		transcriptLines(fixtures.multiCallFullLines.join("\n")),
	);
	expect(isTranscriptItems(items)).toBe(true);
	return items;
};

const homes: Array<string> = [];

/** A disposable `$HOME` with agy's own directory shape under it. */
const withHome = (
	files: {readonly transcript?: string; readonly full?: string},
	conversationId = CID,
): string => {
	const home = mkdtempSync(join(tmpdir(), "agy-transcript-"));
	homes.push(home);
	if (files.transcript !== undefined || files.full !== undefined) {
		const dir = transcriptLogDir(home, conversationId);
		mkdirSync(dir, {recursive: true});
		if (files.transcript !== undefined) writeFileSync(join(dir, TRANSCRIPT_FILE), files.transcript);
		if (files.full !== undefined) writeFileSync(join(dir, TRANSCRIPT_FULL_FILE), files.full);
	}
	return home;
};

afterAll(() => {
	for (const home of homes) rmSync(home, {recursive: true, force: true});
});

const page = (home: string, before: string | null, limit: number) =>
	Effect.runPromise(
		readTranscriptPage({home, conversationId: CID}, {before, limit}).pipe(
			Effect.provide(NodeFileSystem.layer),
		),
	);

describe("the agy transcript reader", () => {
	it("decodes the three named kinds into their items, ordered by step_index", () => {
		const items = itemsOf([fixtures.systemMessage, fixtures.assistantReply, fixtures.userInput]);
		// Handed newest-first on purpose: the answer is the file's `step_index` order, 0/3/5.
		expect(kinds(items)).toEqual(["user", "assistant", "system"]);
		expect(texts(items)[0]).toContain("list the files in this workspace");
		expect(texts(items)[1]).toContain("README.md");
		expect(texts(items)[2]).toContain("<SYSTEM_MESSAGE>");
	});

	it("breaks a step_index tie on the file's own order rather than reordering the pair", () => {
		const items = itemsOf([fixtures.assistantReply, fixtures.assistantReplyClipped]);
		expect(texts(items)).toEqual([
			"The workspace holds a **README.md** and a **src/** directory.",
			`The workspace holds a **READ${CLIPPED_MARK}`,
		]);
	});

	it("reads a clipped field's whole value out of transcript_full.jsonl", () => {
		const items = itemsOf(
			[fixtures.userInput, fixtures.assistantReplyClipped],
			[fixtures.userInput, fixtures.assistantReplyFull],
		);
		expect(texts(items)[1]).toBe("The workspace holds a **README.md** and a **src/** directory.");
		expect(texts(items)[1]).not.toContain(CLIPPED_MARK);
	});

	it("matches the counterpart by step_index when the full file is shorter than its own line", () => {
		// The full file is missing the leading line, so position alone would pair the clipped reply
		// with the wrong record; `step_index` is the cross-check that catches it.
		const items = itemsOf(
			[fixtures.userInput, fixtures.assistantReplyClipped],
			[fixtures.assistantReplyFull],
		);
		expect(texts(items)[1]).toBe("The workspace holds a **README.md** and a **src/** directory.");
	});

	it("serves the clipped content and marks it when the full counterpart is absent", () => {
		const items = itemsOf([fixtures.assistantReplyClipped]);
		expect(texts(items)).toEqual([`The workspace holds a **READ${CLIPPED_MARK}`]);
	});

	it("builds a tool row through the shared constructor's own boundToolResult cut", () => {
		const [tool] = itemsOf([fixtures.toolCall, fixtures.toolResult]) as ReadonlyArray<ToolItem>;
		expect(tool?.kind).toBe("tool");
		expect(tool?.name).toBe("list_dir");
		expect(tool?.status).toBe("ok");
		expect(tool?.input).toMatchObject({DirectoryPath: '"/Users/founder/agyprobe"'});
		expect(tool?.result).toEqual(
			boundToolResult(
				'Created At: 2026-09-02T21:17:49-07:00\nCompleted At: 2026-09-02T21:17:49-07:00\n{"name":"README.md", "isDir":false}\n{"name":"src", "isDir":true}',
			),
		);
	});

	it("cuts an oversized tool result at the port's own byte bound", () => {
		const long = "x".repeat(TOOL_RESULT_BYTE_LIMIT + 500);
		const result = JSON.stringify({
			step_index: 2,
			source: "MODEL",
			type: "GENERIC",
			status: "DONE",
			created_at: "2026-09-03T04:17:49Z",
			content: long,
		});
		const [tool] = itemsOf([fixtures.toolCall, result]) as ReadonlyArray<ToolItem>;
		expect(tool?.result).toEqual(boundToolResult(long));
		expect(tool?.result.omitted.bytes).toBe(500);
	});

	it("keeps a tool row running while its result line says the tool is still in flight", () => {
		const [tool] = itemsOf([
			fixtures.toolCall,
			fixtures.toolResultRunning,
		]) as ReadonlyArray<ToolItem>;
		expect(tool?.status).toBe("running");
	});

	it("keeps a tool row running when agy wrote no result line for it at all", () => {
		const [tool] = itemsOf([fixtures.toolCall]) as ReadonlyArray<ToolItem>;
		expect(tool?.status).toBe("running");
		expect(tool?.result.text).toBe("");
	});

	it("spends the result line on its call rather than also rendering it as a row", () => {
		expect(kinds(itemsOf([fixtures.toolCall, fixtures.toolResult]))).toEqual(["tool"]);
	});

	/**
	 * The regression #8689 fixed, over the driven v1.1.28 capture rather than a constructed pair: one
	 * outcome was copied onto each of N rows, so every row claimed to be the result of that call. agy
	 * writes one `GENERIC` per call in call order, so each row now carries its own — and the capture
	 * is the evidence, because its first outcome sits *before* its call line in the file, which is
	 * what makes the pairing a `step_index` question rather than an adjacency one.
	 */
	it("pairs each call of a captured two-call batch with its own outcome, by position", () => {
		const items = capturedMultiCall();
		expect(kinds(items)).toEqual(["user", "tool", "tool", "assistant"]);
		const [first, second] = items.slice(1, 3) as ReadonlyArray<ToolItem>;
		expect([first?.name, second?.name]).toEqual(["view_file", "view_file"]);
		expect(first?.input).toMatchObject({AbsolutePath: '"/Users/founder/agyprobe/one.txt"'});
		expect(second?.input).toMatchObject({AbsolutePath: '"/Users/founder/agyprobe/two.txt"'});

		// The one.txt outcome is the file's *second* line and the two.txt outcome its fourth, while the
		// call line is its third — so file adjacency would have handed row 0 the two.txt result.
		expect(first?.result.text).toContain("one.txt");
		expect(first?.result.text).toContain("1: alpha");
		expect(first?.result.text).not.toContain("two.txt");
		expect(second?.result.text).toContain("two.txt");
		expect(second?.result.text).toContain("1: bir");
		expect(second?.result.text).not.toContain("one.txt");
		expect([first?.status, second?.status]).toEqual(["ok", "ok"]);
	});

	it("spends every outcome of a captured batch on a call rather than also on a loose row", () => {
		// Four lines in, four items out: nothing is dropped and no `GENERIC` renders twice.
		expect(capturedMultiCall()).toHaveLength(4);
		expect(fixtures.multiCallLines).toHaveLength(5);
	});

	it("keeps a call running when agy has written an outcome for its neighbour and not for it", () => {
		// The second `GENERIC` cut off, which is what a batch agy is still working through looks like.
		const items = itemsOf([
			...fixtures.multiCallLines.slice(0, 3),
		]) as ReadonlyArray<TranscriptItem>;
		const [first, second] = items.slice(1, 3) as ReadonlyArray<ToolItem>;
		expect([first?.status, second?.status]).toEqual(["ok", "running"]);
		expect(first?.result.text).toContain("1: alpha");
		expect(second?.result.text).toBe("");
	});

	it("keeps a one-call batch's outcome on its row, where the attribution is unambiguous", () => {
		const items = itemsOf([fixtures.toolCall, fixtures.toolResult]);
		expect(kinds(items)).toEqual(["tool"]);
		expect(texts(items)[0]).toContain('{"name":"README.md", "isDir":false}');
	});

	/**
	 * #8877: the clip of one outcome's `content` was ORed into every row of the batch, so a row whose
	 * own result arrived whole still read as clipped. Each outcome is its own row's now, so each clip
	 * lands on the row whose field was cut.
	 */
	it("marks only the row whose own outcome content agy clipped", () => {
		const clippedSecond = JSON.stringify({
			...(JSON.parse(fixtures.multiCallLines[3] ?? "{}") as Record<string, unknown>),
			content: "Created At: 2026-09-09T22:21:28-07:00\nFile Path: `file:///Users/founder/agy",
			truncated_fields: ["content"],
		});
		const lines = [...fixtures.multiCallLines];
		lines[3] = clippedSecond;
		const [first, second] = itemsOf(lines).slice(1, 3) as ReadonlyArray<ToolItem>;
		expect(first?.result.text).not.toContain(CLIPPED_MARK);
		expect(first?.result.text).toContain("1: alpha");
		expect(second?.result.text).toContain(CLIPPED_MARK);
	});

	it("keeps the clip mark on a multi-call row whose own tool_calls were cut short", () => {
		const clippedCalls = JSON.stringify({
			step_index: 1,
			source: "MODEL",
			type: "PLANNER_RESPONSE",
			status: "DONE",
			created_at: "2026-09-03T04:17:43Z",
			tool_calls: [
				{name: "list_dir", args: {}},
				{name: "read_file", args: {}},
			],
			truncated_fields: ["tool_calls"],
		});
		const items = itemsOf([clippedCalls]) as ReadonlyArray<ToolItem>;
		expect(items.map((item) => item.result.text)).toEqual([CLIPPED_MARK, CLIPPED_MARK]);
	});

	it("leaves every row of a multi-call line agy has written no outcome for yet running", () => {
		const items = itemsOf([fixtures.multiCallLines[2] ?? ""]);
		expect(kinds(items)).toEqual(["tool", "tool"]);
		expect((items as ReadonlyArray<ToolItem>).map((item) => item.status)).toEqual([
			"running",
			"running",
		]);
		expect((items as ReadonlyArray<ToolItem>).map((item) => item.result.text)).toEqual(["", ""]);
	});

	it("renders a GENERIC line that follows no call, so nothing is dropped", () => {
		const items = itemsOf([fixtures.userInput, fixtures.toolResult]);
		expect(kinds(items)).toEqual(["user", "system"]);
		expect(texts(items)[1]).toContain("unrecognised kind");
	});

	it("renders an unrecognised source/type as a system item and throws on nothing", () => {
		const items = itemsOf([fixtures.unrecognised]);
		expect(kinds(items)).toEqual(["system"]);
		expect(texts(items)[0]).toContain('"ORACLE/PROPHECY"');
		expect(texts(items)[0]).toContain("a kind written by a newer agy");
	});

	it("renders a SYSTEM type the epic's spec never named", () => {
		const items = itemsOf([fixtures.checkpoint]);
		expect(kinds(items)).toEqual(["system"]);
		expect(texts(items)[0]).toContain("CHECKPOINT 0");
	});

	it("drops thinking rather than folding it into the reply", () => {
		const items = itemsOf([fixtures.assistantThinking]);
		expect(texts(items)).toEqual(["Anything else?"]);
	});

	it("skips a half-written trailing line and keeps every line before it", () => {
		const items = itemsOf([fixtures.userInput, fixtures.assistantReply, fixtures.halfWritten]);
		expect(kinds(items)).toEqual(["user", "assistant"]);
	});

	/**
	 * Shared use, proven structurally rather than by two suites that happen to agree: `items.ts` is
	 * the only file in this slice that calls `boundToolResult` or writes a `kind: "tool"` literal, so
	 * the live mapper and this reader cannot be minting tool rows two different ways.
	 */
	it("mints every tool row through the one constructor the live mapper uses", () => {
		const dir = import.meta.dirname;
		const offenders = readdirSync(dir)
			.filter((name) => /\.ts$/.test(name) && !name.includes(".test."))
			.filter((name) => name !== "items.ts")
			.filter((name) => {
				const source = readFileSync(join(dir, name), "utf8");
				return source.includes("boundToolResult(") || source.includes('kind: "tool"');
			});
		expect(offenders).toEqual([]);
	});

	it("resolves the log directory under the home it is handed, never a constant", () => {
		expect(transcriptLogDir("/Users/founder", CID)).toBe(
			`/Users/founder/.gemini/antigravity-cli/brain/${CID}/.system_generated/logs`,
		);
	});
});

/**
 * The frame agy stores the operator's turn in, and the reason it comes off (#8961).
 *
 * The cases run over the v1.2.0 capture rather than a restated line: the wrapper is agy's, it ships
 * no schema, and the blocks it adds are exactly what a reconstruction would smooth over — the first
 * turn's line carries a `<USER_SETTINGS_CHANGE>` block the other two do not.
 */
describe("the operator's own turn, out of agy's <USER_REQUEST> frame", () => {
	const capturedPrompts = (): ReadonlyArray<string> =>
		transcriptItems(
			fixtures.liveJoinConversationId,
			transcriptLines(fixtures.liveJoinLines.join("\n")),
			transcriptLines(fixtures.liveJoinFullLines.join("\n")),
		)
			.filter((item) => item.kind === "user")
			.map((item) => item.text);

	it("mints the bare prompt for every turn the capture holds, settings-change block and all", () => {
		expect(capturedPrompts()).toEqual([
			"In ONE single planner step, issue TWO parallel view_file tool calls: the first on one.txt and the second on two.txt. Then reply with ONLY the two line counts as bare digits separated by a comma. Write no file names, no paths, no links, no URLs in your reply.",
			"Now reply with only the word DONE and run no tools. No paths, no links.",
			"Reply with only the word AGAIN and run no tools. No paths, no links.",
		]);
	});

	it("leaves no block of agy's framing in the row, which is what the operator would read", () => {
		for (const prompt of capturedPrompts()) {
			expect(prompt).not.toContain("USER_REQUEST");
			expect(prompt).not.toContain("ADDITIONAL_METADATA");
			expect(prompt).not.toContain("USER_SETTINGS_CHANGE");
		}
	});

	it("passes a line carrying no wrapper through unchanged, since the block set is not closed", () => {
		const bare =
			'{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-09-03T04:17:43Z","content":"list the files in this workspace"}';
		expect(texts(itemsOf([bare]))).toEqual(["list the files in this workspace"]);
	});

	it("serves a clipped turn framed rather than half-unwrapped, marked as the clip it is", () => {
		// The close tag is in the part agy cut, so there is no body to read: the frame stands, and the
		// mark says why. Half a wrapper rendered as the prompt would read as the prompt.
		const clipped =
			'{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-09-03T04:17:43Z","content":"<USER_REQUEST>\\nlist the files in this","truncated_fields":["content"]}';
		expect(texts(itemsOf([clipped]))).toEqual([
			`<USER_REQUEST>\nlist the files in this${CLIPPED_MARK}`,
		]);
	});
});

describe("the agy transcript page", () => {
	const conversation = [
		fixtures.userInput,
		fixtures.toolCall,
		fixtures.toolResult,
		fixtures.assistantReply,
		fixtures.systemMessage,
		fixtures.checkpoint,
	].join("\n");

	it("yields an empty page for a conversation agy has written no directory for", async () => {
		const answer = await page(withHome({}), null, 10);
		expect(isRefusal(answer)).toBe(false);
		expect((answer as TranscriptPage).items).toEqual([]);
		expect((answer as TranscriptPage).next).toBeNull();
	});

	it("yields an empty page for a directory holding no transcript.jsonl", async () => {
		const answer = await page(withHome({full: ""}), null, 10);
		expect((answer as TranscriptPage).items).toEqual([]);
	});

	it("reads the whole history off disk when the limit covers it", async () => {
		const answer = (await page(withHome({transcript: conversation}), null, 20)) as TranscriptPage;
		expect(kinds(answer.items)).toEqual(["user", "tool", "assistant", "system", "system"]);
		expect(answer.next).toBeNull();
	});

	it("honours before and limit across a page boundary, oldest reachable by walking back", async () => {
		const home = withHome({transcript: conversation});
		const newest = (await page(home, null, 1)) as TranscriptPage;
		expect(kinds(newest.items)).toEqual(["system"]);
		expect(texts(newest.items)[0]).toContain("CHECKPOINT 0");
		expect(newest.next).not.toBeNull();

		const older = (await page(home, newest.next, 1)) as TranscriptPage;
		expect(texts(older.items)[0]).toContain("<SYSTEM_MESSAGE>");

		const oldest = (await page(home, older.next, 10)) as TranscriptPage;
		// The exchange is atomic, so the prompt, its tool call and the reply come back whole.
		expect(kinds(oldest.items)).toEqual(["user", "tool", "assistant"]);
		expect(oldest.next).toBeNull();
	});

	it("refuses a cursor no item carries rather than serving a silently wrong page", async () => {
		const answer = await page(withHome({transcript: conversation}), "no-such-item", 10);
		expect(isRefusal(answer)).toBe(true);
	});

	it("reads the full file off disk for a clipped line", async () => {
		const home = withHome({
			transcript: [fixtures.userInput, fixtures.assistantReplyClipped].join("\n"),
			full: [fixtures.userInput, fixtures.assistantReplyFull].join("\n"),
		});
		const answer = (await page(home, null, 10)) as TranscriptPage;
		expect(texts(answer.items)[1]).toBe(
			"The workspace holds a **README.md** and a **src/** directory.",
		);
	});
});
