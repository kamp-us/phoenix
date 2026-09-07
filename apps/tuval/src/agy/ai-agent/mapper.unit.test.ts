/**
 * The agy fold, over captured v1.1.27 stream lines rather than a live CLI.
 *
 * **Nothing here enumerates the observed `step_type`s as exhaustive.** The cases below name the
 * five that were observed and the eleven that were not, and every one of them is a claim about
 * that value alone — an assertion that the observed set is closed would rebuild the exact defect
 * the default arm exists to prevent, on a wire that ships no version field to warn anyone.
 */

import {describe, expect, it} from "vitest";
import {addUsage, emptyUsage, usageTotals} from "../../ai-agent/core/index.ts";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {
	boundToolResult,
	isTranscriptItem,
	TOOL_RESULT_BYTE_LIMIT,
	type ToolItem,
	type TranscriptItem,
} from "../../ai-agent/ports/index.ts";
import * as fixtures from "./fixtures.ts";
import {type AgyTurn, eventsOf, idleTurn, turnFrom} from "./mapper.ts";

const AT = 1_700_000_000_000;

const fold = (
	lines: ReadonlyArray<string>,
	start: AgyTurn = idleTurn,
): {readonly events: ReadonlyArray<AgentEvent>; readonly turn: AgyTurn} => {
	let turn = start;
	const events: Array<AgentEvent> = [];
	for (const line of lines) {
		const folded = eventsOf(turn, line, AT);
		turn = folded.next;
		events.push(...folded.events);
	}
	expect(
		events.filter((event) => event.kind === "item").every((event) => isTranscriptItem(event.item)),
	).toBe(true);
	return {events, turn};
};

/** What the core's `addUsage` would hold after folding these events — a plain sum, no dedupe. */
const summed = (
	events: ReadonlyArray<AgentEvent>,
): {readonly inputTokens: number; readonly outputTokens: number} =>
	events
		.filter((event) => event.kind === "usage")
		.reduce(
			(total, event) => ({
				inputTokens: total.inputTokens + event.inputTokens,
				outputTokens: total.outputTokens + event.outputTokens,
			}),
			{inputTokens: 0, outputTokens: 0},
		);

const items = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<TranscriptItem> =>
	events.flatMap((event) => (event.kind === "item" ? [event.item] : []));

/** A captured line with its `step_update` patched — so even a synthetic case rides a real envelope. */
const patchStep = (line: string, patch: Record<string, unknown>): string => {
	const parsed = JSON.parse(line) as {step_update: Record<string, unknown>};
	return JSON.stringify({...parsed, step_update: {...parsed.step_update, ...patch}});
};

const patchResult = (line: string, patch: Record<string, unknown>): string => {
	const parsed = JSON.parse(line) as {result: Record<string, unknown>};
	return JSON.stringify({...parsed, result: {...parsed.result, ...patch}});
};

describe("an unrecognised step_type", () => {
	// The six that exist as strings in the agy binary and have never been emitted.
	const neverEmitted = ["thinking", "plan", "error", "command", "memory", "checkpoint"];

	for (const stepType of neverEmitted) {
		it(`renders "${stepType}" as a system row rather than dropping or throwing it`, () => {
			const {events} = fold([patchStep(fixtures.userInput, {step_type: stepType})]);
			const rendered = items(events);
			expect(rendered).toHaveLength(1);
			expect(rendered[0]?.kind).toBe("system");
			expect(rendered[0]?.kind === "system" && rendered[0].text).toContain(stepType);
		});
	}

	it("renders a step type nobody has ever seen as a system row too", () => {
		const invented = "a_step_type_agy_has_never_shipped";
		const {events} = fold([
			patchStep(fixtures.userInput, {step_type: invented, text_delta: "payload"}),
		]);
		const rendered = items(events);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]?.kind).toBe("system");
		expect(rendered[0]?.kind === "system" && rendered[0].text).toContain(invented);
		expect(rendered[0]?.kind === "system" && rendered[0].text).toContain("payload");
	});

	it("keeps its usage even though its content is unrecognised", () => {
		const {events} = fold([
			patchStep(fixtures.responseDone, {step_type: "checkpoint", text_delta: "x"}),
		]);
		expect(events.filter((event) => event.kind === "usage")).toHaveLength(1);
	});
});

describe("a line the reader cannot use", () => {
	it("degrades a non-JSON line to a system row and keeps the stream alive", () => {
		const {events} = fold([`{"event":"step_update"`, fixtures.responseActive]);
		const rendered = items(events);
		expect(rendered).toHaveLength(2);
		expect(rendered[0]?.kind).toBe("system");
		expect(rendered[1]?.kind).toBe("assistant");
	});

	it("degrades a step_update missing the fields that route it", () => {
		const {events} = fold([JSON.stringify({event: "step_update", step_update: {state: "DONE"}})]);
		expect(items(events)[0]?.kind).toBe("system");
	});

	it("degrades a tool step whose optional payload is missing altogether", () => {
		const line = JSON.stringify({
			event: "step_update",
			step_update: {
				conversation_id: "c",
				step_index: 4,
				state: "DONE",
				step_type: "tool",
			},
		});
		const rendered = items(fold([line]).events);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]?.kind).toBe("system");
	});

	it("gives two unreadable lines two ids, so neither supersedes the other", () => {
		const {events} = fold(["not json at all", "also not json"]);
		const rendered = items(events);
		expect(rendered).toHaveLength(2);
		expect(rendered[0]?.id).not.toBe(rendered[1]?.id);
	});

	it("emits nothing for a blank separator line", () => {
		expect(fold(["", "   "]).events).toEqual([]);
	});
});

describe("the five observed step types", () => {
	it("takes no transcript row from a user_input step, which carries no text at v1.1.27", () => {
		expect(items(fold([fixtures.userInput]).events)).toEqual([]);
	});

	it("renders a user_input step that does carry text as a user row", () => {
		const rendered = items(fold([patchStep(fixtures.userInput, {text_delta: "say hello"})]).events);
		expect(rendered[0]).toMatchObject({kind: "user", text: "say hello", timestamp: AT});
	});

	it("renders an agent_response delta as an assistant row", () => {
		const rendered = items(fold([fixtures.responseActive]).events);
		expect(rendered[0]).toMatchObject({kind: "assistant", timestamp: AT});
		expect(rendered[0]?.kind === "assistant" && rendered[0].text).toContain("**5** files");
	});

	it("renders a tool step as a tool row carrying the call's own parameters", () => {
		const rendered = items(fold([fixtures.toolActive]).events);
		expect(rendered[0]).toMatchObject({
			kind: "tool",
			name: "list_dir",
			status: "running",
			input: {DirectoryPath: "/tmp/agyprobe"},
			result: {text: "", omitted: {bytes: 0}},
		});
	});

	it("renders a subagent step as a tool row over the same running/done shape", () => {
		const rendered = items(fold([fixtures.subagentActive]).events);
		expect(rendered[0]).toMatchObject({kind: "tool", name: "invoke_subagent", status: "running"});
		const input = (rendered[0] as ToolItem).input as {subagents: ReadonlyArray<{role: string}>};
		expect(input.subagents[0]?.role).toBe("Robotics Historian");
	});

	it("takes no row from a system_message step with no text, and one from a system_message with text", () => {
		expect(items(fold([fixtures.systemMessage]).events)).toEqual([]);
		const rendered = items(
			fold([patchStep(fixtures.systemMessage, {text_delta: "context compacted"})]).events,
		);
		expect(rendered[0]).toMatchObject({kind: "system", text: "context compacted"});
	});
});

describe("the tool arm", () => {
	it("re-sends the running row's id on DONE, with tool_info.output as the result", () => {
		const rendered = items(fold([fixtures.toolActive, fixtures.toolDone]).events);
		expect(rendered).toHaveLength(2);
		expect(rendered[0]?.id).toBe(rendered[1]?.id);
		expect(rendered[0]).toMatchObject({status: "running"});
		expect(rendered[1]).toMatchObject({
			status: "ok",
			result: boundToolResult("err.txt\nout.ndjson\nsample.txt\ntool.err\ntool.ndjson"),
		});
	});

	it("maps ERROR off tool_info.error", () => {
		const rendered = items(fold([fixtures.toolError]).events);
		expect(rendered[0]).toMatchObject({kind: "tool", name: "view_file", status: "error"});
		const result = (rendered[0] as ToolItem).result;
		expect(result.text).toContain("TOOL_ERROR");
		expect(result.text).toContain("no such file or directory");
	});

	it("passes the result text through boundToolResult", () => {
		const output = "x".repeat(TOOL_RESULT_BYTE_LIMIT + 500);
		const rendered = items(
			fold([patchStep(fixtures.toolDone, {tool_info: {name: "list_dir", output}})]).events,
		);
		expect((rendered[0] as ToolItem).result).toEqual(boundToolResult(output));
		expect((rendered[0] as ToolItem).result.omitted.bytes).toBe(500);
	});
});

describe("the subagent arm", () => {
	it("drives ACTIVE→DONE off state alone, on two payloads identical apart from it", () => {
		const active = fixtures.subagentActive;
		const done = active.replace('"state":"ACTIVE"', '"state":"DONE"');
		expect(done).not.toBe(active);
		expect(done.replace('"state":"DONE"', '"state":"ACTIVE"')).toBe(active);

		const rendered = items(fold([active, done]).events);
		expect(rendered[0]?.id).toBe(rendered[1]?.id);
		expect(rendered[0]).toMatchObject({status: "running"});
		expect(rendered[1]).toMatchObject({status: "ok"});
		expect({...(rendered[0] as ToolItem), status: "x"}).toEqual({
			...(rendered[1] as ToolItem),
			status: "x",
		});
	});

	it("carries no result summary on the captured DONE either, so state is all there is to read", () => {
		const rendered = items(fold([fixtures.subagentActive, fixtures.subagentDone]).events);
		expect((rendered[1] as ToolItem).result.text).toBe("");
		expect((rendered[0] as ToolItem).input).toEqual((rendered[1] as ToolItem).input);
	});
});

describe("the turn's text", () => {
	it("streams deltas incrementally: the DONE step carries the last chunk, not the accumulation", () => {
		const first = (JSON.parse(fixtures.responseActive) as {step_update: {text_delta: string}})
			.step_update.text_delta;
		const last = (JSON.parse(fixtures.responseDone) as {step_update: {text_delta: string}})
			.step_update.text_delta;
		expect(last.startsWith(first)).toBe(false);
		expect(last).not.toContain("The current directory contains");

		const rendered = items(fold([fixtures.responseActive, fixtures.responseDone]).events);
		expect(rendered[0]?.id).toBe(rendered[1]?.id);
		expect(rendered[0]?.kind === "assistant" && rendered[0].text).toBe(first);
		expect(rendered[1]?.kind === "assistant" && rendered[1].text).toBe(first + last);
	});

	it("takes the whole reply from result.response, superseding the streamed accumulation", () => {
		const response = (JSON.parse(fixtures.resultSuccess) as {result: {response: string}}).result
			.response;
		const rendered = items(
			fold([fixtures.responseActive, fixtures.responseDone, fixtures.resultSuccess]).events,
		);
		expect(rendered).toHaveLength(3);
		expect(rendered[2]?.id).toBe(rendered[0]?.id);
		expect(rendered[2]?.kind === "assistant" && rendered[2].text).toBe(response);
	});

	it("mints a response row even when no delta ever arrived", () => {
		const rendered = items(fold([fixtures.resultSuccess]).events);
		expect(rendered[0]?.kind).toBe("assistant");
	});
});

describe("usage", () => {
	it("reaches a UsageEvent from step_update.usage, named by the model init announced", () => {
		const {events} = fold([fixtures.init, fixtures.responseDone]);
		expect(events.filter((event) => event.kind === "usage")).toEqual([
			{
				kind: "usage",
				turn: "agy:usage:0",
				model: "agy/gemini-3.8-flash-low",
				inputTokens: 4481,
				outputTokens: 110,
				cost: 0,
			},
		]);
	});

	// `result.usage` is the turn's total, not another increment, and the core sums every usage
	// event it is handed under a key it has not seen (`ai-agent/core/fold.ts`'s `addUsage`), which
	// is why each report carries its own ordinal key (`AgyTurn.usageReports`). The cases below pin the residual
	// against agy's own captured numbers rather than against the arithmetic that produced it.
	it("reports result.usage as a residual, so the captured turn totals agy's own numbers", () => {
		const {events} = fold([fixtures.init, fixtures.responseDone, fixtures.resultSuccess]);
		expect(events.filter((event) => event.kind === "usage")).toEqual([
			{
				kind: "usage",
				turn: "agy:usage:0",
				model: "agy/gemini-3.8-flash-low",
				inputTokens: 4481,
				outputTokens: 110,
				cost: 0,
			},
			{
				kind: "usage",
				turn: "agy:usage:1",
				model: "agy/gemini-3.8-flash-low",
				inputTokens: 20963 - 4481,
				outputTokens: 151 - 110,
				cost: 0,
			},
		]);
		expect(summed(events)).toEqual({inputTokens: 20963, outputTokens: 151});
	});

	it("reports the whole of result.usage when no step carried any", () => {
		const {events} = fold([fixtures.init, fixtures.resultSuccess]);
		expect(summed(events)).toEqual({inputTokens: 20963, outputTokens: 151});
	});

	it("emits no result usage at all when the steps already reported the whole total", () => {
		const total = {input_tokens: 4481, output_tokens: 110, total_tokens: 4591};
		const {events} = fold([
			fixtures.init,
			fixtures.responseDone,
			patchResult(fixtures.resultSuccess, {usage: total}),
		]);
		expect(events.filter((event) => event.kind === "usage")).toHaveLength(1);
	});

	it("never hands the core a negative increment when a step over-reports", () => {
		const under = {input_tokens: 10, output_tokens: 1, total_tokens: 11};
		const {events} = fold([
			fixtures.init,
			fixtures.responseDone,
			patchResult(fixtures.resultSuccess, {usage: under}),
		]);
		expect(summed(events)).toEqual({inputTokens: 4481, outputTokens: 110});
	});

	it("carries no usage across the turn boundary, so a second turn's residual is its own", () => {
		const {turn} = fold([fixtures.init, fixtures.responseDone, fixtures.resultSuccess]);
		const {events} = fold([fixtures.resultSuccess], turn);
		expect(summed(events)).toEqual({inputTokens: 20963, outputTokens: 151});
	});

	it("keys a respawned child's usage past what the previous child spent", () => {
		// A respawn (`setModel` / `setMode` / `setThinkingLevel`) mints a fresh carry for the new
		// child while the core keeps the ledger it already has, so the ordinal is seeded from the
		// session rather than restarted — `addUsage` keeps the *first* entry under a key it has seen.
		const first = fold([fixtures.init, fixtures.responseDone, fixtures.resultSuccess]);
		const second = fold(
			[fixtures.init, fixtures.responseDone, fixtures.resultSuccess],
			turnFrom(first.turn.usageReports),
		);
		const usage = [...first.events, ...second.events].filter((event) => event.kind === "usage");
		expect(usage.map((event) => event.turn)).toEqual([
			"agy:usage:0",
			"agy:usage:1",
			"agy:usage:2",
			"agy:usage:3",
		]);
		const totals = usageTotals(usage.reduce(addUsage, emptyUsage));
		expect(totals).toMatchObject({inputTokens: 20963 * 2, outputTokens: 151 * 2});
	});

	it("falls back to the bare binary name when init announced no model", () => {
		const initWithoutModel = JSON.stringify({
			event: "init",
			conversation_id: "c",
			init: {cwd: "/tmp", permission_mode: "request-review"},
		});
		const {events} = fold([initWithoutModel, fixtures.responseDone]);
		expect(events.find((event) => event.kind === "usage")?.model).toBe("agy");
	});

	it("emits nothing at all for init itself", () => {
		expect(fold([fixtures.init]).events).toEqual([]);
	});
});

describe("the terminal result", () => {
	it("reports a non-SUCCESS status as a failure, keeping the session alive", () => {
		const {events} = fold([
			patchResult(fixtures.resultSuccess, {
				status: "ERROR",
				error: "timeout waiting for response",
			}),
		]);
		expect(events.at(-1)).toEqual({
			kind: "failure",
			failure: {
				tag: "AgyTurnFailed",
				reason: "ERROR",
				detail: "timeout waiting for response",
			},
		});
	});

	it("reads a status this pin has never seen as a failure rather than a success", () => {
		const {events} = fold([patchResult(fixtures.resultSuccess, {status: "INTERRUPTED"})]);
		expect(events.at(-1)).toMatchObject({kind: "failure", failure: {reason: "INTERRUPTED"}});
	});

	it("surfaces denied_actions as a system row instead of swallowing them", () => {
		const {events} = fold([
			patchResult(fixtures.resultSuccess, {denied_actions: [{tool: "run_command"}]}),
		]);
		const denied = items(events).find(
			(item) => item.kind === "system" && item.text.includes("denied"),
		);
		expect(denied?.kind === "system" && denied.text).toContain("run_command");
	});

	it("clears the turn's response row, so the next turn opens its own", () => {
		const {turn} = fold([fixtures.responseActive, fixtures.resultSuccess]);
		expect(turn.responseId).toBeNull();
		expect(turn.responseText).toBe("");
	});
});
