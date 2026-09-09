/**
 * The child artifact's grammar, over lines shaped exactly as `pi-subagents`
 * `src/shared/child-transcript.ts` writes them. It is reimplemented rather than imported, so the
 * only thing holding the two in step is a test that spells the records out.
 */

import {describe, expect, it} from "vitest";
import {parseChildTranscript} from "./child-transcript.ts";

const base = (recordType: string, ts: number) => ({
	version: 1,
	recordType,
	source: "foreground",
	runId: "run-1",
	agent: "reviewer",
	childIndex: 0,
	cwd: "/repo",
	ts,
	timestamp: new Date(ts).toISOString(),
});

const assistant = (text: string, ts: number, usage?: Record<string, number>) => ({
	...base("message", ts),
	sourceEventType: "message_end",
	role: "assistant",
	text,
	model: "anthropic/opus",
	...(usage === undefined ? {} : {usage}),
	message: {role: "assistant", content: [{type: "text", text}]},
});

const toolStart = (toolCallId: string, toolName: string, ts: number) => ({
	...base("tool_start", ts),
	sourceEventType: "tool_execution_start",
	toolCallId,
	toolName,
	argsPreview: "src/a.ts",
	argsPayload: JSON.stringify({path: "src/a.ts"}),
});

const toolResult = (toolCallId: string, text: string, ts: number, isError = false) => ({
	...base("message", ts),
	sourceEventType: "tool_result_end",
	role: "toolResult",
	toolCallId,
	toolName: "read",
	isError,
	text,
	message: {role: "toolResult", toolCallId, toolName: "read", isError, content: []},
});

const lines = (records: ReadonlyArray<unknown>): string =>
	records.map((record) => `${JSON.stringify(record)}\n`).join("");

describe("the child transcript's record grammar", () => {
	it("maps assistant, user and tool records onto the port's own kinds", () => {
		const parsed = parseChildTranscript(
			lines([
				{...base("message", 1), role: "user", text: "PROMPT_REDACTED", message: {role: "user"}},
				assistant("reading the file", 2),
				toolStart("t-1", "read", 3),
				toolResult("t-1", "export const a = 1", 4),
			]),
		);
		expect(parsed.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool"]);
		expect(parsed.items[2]).toMatchObject({
			kind: "tool",
			name: "read",
			input: {path: "src/a.ts"},
			status: "ok",
		});
		expect(parsed.lastLine).toBe("export const a = 1");
	});

	it.each([
		["a call still running", [toolStart("t-1", "read", 3)], "running"],
		["a call that answered", [toolStart("t-1", "read", 3), toolResult("t-1", "ok", 4)], "ok"],
		[
			"a call that failed",
			[toolStart("t-1", "read", 3), toolResult("t-1", "no such file", 4, true)],
			"error",
		],
		[
			"a call the writer ended without a result",
			[toolStart("t-1", "read", 3), {...base("tool_end", 4), toolCallId: "t-1", isError: true}],
			"error",
		],
	])("reads %s as %s", (_case, records, status) => {
		const parsed = parseChildTranscript(lines(records));
		expect(parsed.items).toHaveLength(1);
		expect(parsed.items[0]).toMatchObject({kind: "tool", status});
	});

	// stderr is the child's own plumbing and the port has no kind for it; a `thinking` row is never
	// written at all, because the writer extracts text only.
	it("drops a stderr notice", () => {
		const parsed = parseChildTranscript(
			lines([{...base("stderr", 1), text: "warning: slow"}, assistant("done", 2)]),
		);
		expect(parsed.items.map((item) => item.kind)).toEqual(["assistant"]);
	});

	it("sums the normalized per-record usage", () => {
		const parsed = parseChildTranscript(
			lines([
				assistant("one", 1, {input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.1}),
				assistant("two", 2, {input: 20, output: 6, cacheRead: 0, cacheWrite: 0, cost: 0.2}),
			]),
		);
		expect(parsed.tokens).toBe(40);
	});

	// The file is appended to while it is read, so its last line may be half written. The completed
	// records still have to read back, or a live tail loses everything on every partial flush.
	it("drops an incomplete trailing record and keeps the completed ones", () => {
		const whole = lines([assistant("first", 1), assistant("second", 2)]);
		const truncated = `${whole}{"version":1,"recordType":"mess`;
		const parsed = parseChildTranscript(truncated);
		expect(parsed.items.map((item) => item.kind === "assistant" && item.text)).toEqual([
			"first",
			"second",
		]);
		expect(parsed.lastLine).toBe("second");
	});

	it("keeps a final record the writer had not newline-terminated yet", () => {
		const parsed = parseChildTranscript(JSON.stringify(assistant("only", 1)));
		expect(parsed.items).toHaveLength(1);
	});

	it("skips a malformed line rather than failing the read", () => {
		const parsed = parseChildTranscript(`not json\n${lines([assistant("still here", 2)])}`);
		expect(parsed.items).toHaveLength(1);
		expect(parsed.tokens).toBe(0);
	});

	it("reads an empty artifact as an empty slot", () => {
		expect(parseChildTranscript("")).toEqual({items: [], lastLine: "", tokens: 0});
	});
});
