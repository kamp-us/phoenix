/**
 * The child artifact's grammar, over lines shaped exactly as `pi-subagents`
 * `src/shared/child-transcript.ts` writes them, and the merge that reads a run's artifacts off disk
 * on top of it. Both are reimplemented rather than imported, so the only thing holding them in step
 * with `pi-subagents` is a test that spells the records and the file names out.
 */

import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {
	type ChildTranscript,
	parseChildTranscript,
	readChildTranscript,
} from "./child-transcript.ts";

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

/**
 * `getArtifactPaths` mints `${runId}_${safeAgent}${suffix}_transcript.jsonl`, and the suffix is
 * `_${index}` only when the run has more than one step (`src/shared/artifacts.ts`;
 * `src/runs/background/subagent-runner.ts:851` passes `ctx.flatStepCount > 1 ? ctx.flatIndex :
 * undefined`) — so these are the names a real run writes.
 */
const artifact = (runId: string, agent: string, index?: number): string =>
	`${runId}_${agent}${index === undefined ? "" : `_${index}`}_transcript.jsonl`;

const assistantTexts = (transcript: ChildTranscript): ReadonlyArray<string> =>
	transcript.items.flatMap((item) => (item.kind === "assistant" ? [item.text] : []));

describe("the merge over one run's artifacts", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "child-transcript-"));
	});

	afterEach(() => {
		rmSync(dir, {recursive: true, force: true});
	});

	const write = (name: string, records: ReadonlyArray<unknown>): void =>
		writeFileSync(join(dir, name), lines(records), "utf-8");

	// The name puts the agent before the index, so a sort over the whole name ranks the steps
	// alphabetically by agent — two steps on different agents is already enough to invert them.
	it("orders the steps by their index, not by the agent name the index sits behind", () => {
		write(artifact("run-1", "beta", 0), [assistant("step zero", 1)]);
		write(artifact("run-1", "alpha", 1), [assistant("step one", 2)]);
		expect(assistantTexts(readChildTranscript(dir, "run-1"))).toEqual(["step zero", "step one"]);
	});

	it("orders past nine, where the bare decimal index as text would put ten before two", () => {
		write(artifact("run-1", "worker", 2), [assistant("step two", 1)]);
		write(artifact("run-1", "worker", 10), [assistant("step ten", 2)]);
		expect(assistantTexts(readChildTranscript(dir, "run-1"))).toEqual(["step two", "step ten"]);
	});

	it("reads a single-step run back, whose artifact carries no index suffix at all", () => {
		write(artifact("run-1", "solo"), [assistant("only step", 1)]);
		expect(assistantTexts(readChildTranscript(dir, "run-1"))).toEqual(["only step"]);
	});

	it("re-keys every row apart, sums the spend, and takes the newest line from the last step", () => {
		write(artifact("run-1", "beta", 0), [
			assistant("zero first", 1, {input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0}),
			assistant("zero second", 2),
		]);
		write(artifact("run-1", "alpha", 1), [
			assistant("one first", 3, {input: 20, output: 6, cacheRead: 0, cacheWrite: 0, cost: 0}),
			assistant("one last", 4),
		]);
		const merged = readChildTranscript(dir, "run-1");
		const ids = merged.items.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(merged.tokens).toBe(40);
		expect(merged.lastLine).toBe("one last");
	});

	it("skips another run's artifacts sitting in the same directory", () => {
		write(artifact("run-1", "worker", 0), [assistant("ours", 1)]);
		write(artifact("run-2", "worker", 0), [
			assistant("theirs", 2, {input: 99, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0}),
		]);
		const merged = readChildTranscript(dir, "run-1");
		expect(assistantTexts(merged)).toEqual(["ours"]);
		expect(merged.tokens).toBe(0);
	});

	it("reads a directory that does not exist yet as an empty slot", () => {
		expect(readChildTranscript(join(dir, "not-yet"), "run-1")).toEqual({
			items: [],
			lastLine: "",
			tokens: 0,
		});
	});
});
