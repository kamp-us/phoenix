/**
 * The agy fold, over captured stream lines rather than a live CLI — v1.1.27 throughout, plus the
 * v1.1.28 usage census and interrupted `result` that `fixtures.ts` declares as such.
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
import {type AgyTurn, eventsOf, idleTurn} from "./mapper.ts";

const AT = 1_700_000_000_000;

/** The conversation every `fixtures.result*`/`response*` line above carries, and so every usage key. */
const CONVERSATION = "9dcbb5a5-9a5f-4f9c-989b-ede03e790bbf";

/** The one the three-turn usage census ran on. */
const CENSUS_CONVERSATION = "cba39437-e61b-48f0-a7cd-d78b59b6fcae";

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

/** A captured `result` with `num_turns` taken off it — the line a later agy release could send. */
const withoutNumTurns = (line: string): string => {
	const parsed = JSON.parse(line) as {result: Record<string, unknown>};
	const {num_turns: _dropped, ...result} = parsed.result;
	return JSON.stringify({...parsed, result});
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
				turn: `agy:usage:${CONVERSATION}:step:3`,
				model: "agy/gemini-3.8-flash-low",
				inputTokens: 4481,
				outputTokens: 110,
				cost: 0,
			},
		]);
	});

	// `result.usage` is the *conversation's* running total and the core sums every usage event it is
	// handed under a key it has not seen (`ai-agent/core/fold.ts`'s `addUsage`), so a first turn's
	// result is reported as the residual of what its steps already said. The cases below pin that
	// against agy's own captured numbers rather than against the arithmetic that produced it.
	it("reports result.usage as a residual, so the captured turn totals agy's own numbers", () => {
		const {events} = fold([fixtures.init, fixtures.responseDone, fixtures.resultSuccess]);
		expect(events.filter((event) => event.kind === "usage")).toEqual([
			{
				kind: "usage",
				turn: `agy:usage:${CONVERSATION}:step:3`,
				model: "agy/gemini-3.8-flash-low",
				inputTokens: 4481,
				outputTokens: 110,
				cost: 0,
			},
			{
				kind: "usage",
				turn: `agy:usage:${CONVERSATION}:turn:1`,
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

	// The three-turn census is the whole of the evidence that `result.usage` is cumulative, so the
	// cases below fold it rather than a synthetic second turn: a one-turn capture cannot tell a
	// per-turn total from a conversation total, which is exactly how #8695 got written.
	it("totals a three-turn conversation at agy's own last cumulative, not at the sum of them", () => {
		const census = [
			fixtures.init,
			fixtures.censusTurnOneStep,
			fixtures.censusTurnOneResult,
			fixtures.censusTurnTwoStep,
			fixtures.censusTurnTwoResult,
		];
		const {events} = fold(census);
		expect(summed(events)).toEqual({inputTokens: 21419, outputTokens: 2});
	});

	it("reports a second turn as its own spend and not again as the first's", () => {
		const {events} = fold([
			fixtures.init,
			fixtures.censusTurnOneStep,
			fixtures.censusTurnOneResult,
			fixtures.censusTurnTwoStep,
			fixtures.censusTurnTwoResult,
		]);
		const usage = events.filter((event) => event.kind === "usage");
		expect(usage.map((event) => event.turn)).toEqual([
			`agy:usage:${CENSUS_CONVERSATION}:step:1`,
			`agy:usage:${CENSUS_CONVERSATION}:step:3`,
		]);
		// The second turn spent 4648 in. A `result` read as that turn's own total would report
		// 21419 − 4648 = 16771 — the first turn's spend, a second time, under a key of its own.
		expect(usage.map((event) => event.inputTokens)).toEqual([16771, 4648]);
	});

	it("leaves a restored session's totals exactly where the checkpoint left them", () => {
		// The restore: the desk boots over a checkpointed ledger, the layer is rebuilt from nothing
		// (`idleTurn`, no ordinal and no cumulative), and `start({resume})` reopens the conversation on
		// a new child. What the ledger already holds must neither grow nor be aliased away (#8695).
		const before = fold([
			fixtures.init,
			fixtures.censusTurnOneStep,
			fixtures.censusTurnOneResult,
			fixtures.censusTurnTwoStep,
			fixtures.censusTurnTwoResult,
		]);
		const checkpointed = before.events
			.filter((event) => event.kind === "usage")
			.reduce(addUsage, emptyUsage);
		expect(usageTotals(checkpointed)).toMatchObject({inputTokens: 21419, outputTokens: 2});

		// The resumed child replays nothing (measured: eight seconds of silence after `init` before
		// any prompt), so a restore with no further turn hands the ledger nothing at all.
		const restored = fold([fixtures.init], idleTurn);
		expect(restored.events.filter((event) => event.kind === "usage")).toEqual([]);
		const afterRestore = restored.events
			.filter((event) => event.kind === "usage")
			.reduce(addUsage, checkpointed);
		expect(usageTotals(afterRestore)).toMatchObject({inputTokens: 21419, outputTokens: 2});

		// And the turn run *after* the restore adds its own spend, once: keyed on agy's own step and
		// turn numbers, it can neither land on an entry the checkpoint holds nor be counted twice.
		const third = fold([fixtures.init, fixtures.censusResumedStep, fixtures.censusResumedResult]);
		const totals = usageTotals(
			third.events.filter((event) => event.kind === "usage").reduce(addUsage, afterRestore),
		);
		expect(totals).toMatchObject({inputTokens: 21419 + 4861, outputTokens: 3});
	});

	it("re-folds a replayed turn onto the entry it already wrote rather than a second one", () => {
		const once = fold([fixtures.init, fixtures.censusTurnOneStep, fixtures.censusTurnOneResult]);
		const ledger = once.events
			.filter((event) => event.kind === "usage")
			.reduce(addUsage, emptyUsage);
		// The same lines again, through a carry that knows nothing — a replay from a rebuilt layer.
		const again = fold([fixtures.init, fixtures.censusTurnOneStep, fixtures.censusTurnOneResult]);
		const totals = usageTotals(
			again.events.filter((event) => event.kind === "usage").reduce(addUsage, ledger),
		);
		expect(totals).toMatchObject({inputTokens: 16771, outputTokens: 1});
	});

	it("keys a respawned child's usage past what the previous child spent", () => {
		// A respawn (`setModel` / `setMode` / `setThinkingLevel`) mints a fresh carry for the new child
		// while the core keeps the ledger it already has. The new child resumes the same conversation,
		// so its steps carry step indices the first child never used and its `result` a higher
		// `num_turns` — and nothing has to be handed across the respawn for the keys to stay apart.
		const first = fold([
			fixtures.init,
			fixtures.censusTurnOneStep,
			fixtures.censusTurnOneResult,
			fixtures.censusTurnTwoStep,
			fixtures.censusTurnTwoResult,
		]);
		const second = fold([fixtures.init, fixtures.censusResumedStep, fixtures.censusResumedResult]);
		const usage = [...first.events, ...second.events].filter((event) => event.kind === "usage");
		expect(usage.map((event) => event.turn)).toEqual([
			`agy:usage:${CENSUS_CONVERSATION}:step:1`,
			`agy:usage:${CENSUS_CONVERSATION}:step:3`,
			`agy:usage:${CENSUS_CONVERSATION}:step:6`,
		]);
		const totals = usageTotals(usage.reduce(addUsage, emptyUsage));
		expect(totals).toMatchObject({inputTokens: 21419 + 4861, outputTokens: 3});
	});

	// agy v1.1.27 sends `num_turns` on every captured `result` and the stream carries no version field
	// to branch on, so a later release dropping it is exactly the case `wire.ts`'s tolerance is for.
	// The unknown takes the arm that cannot over-charge (#8707).
	describe("a result agy sent no num_turns on", () => {
		it("reports a first turn from its own steps, not from the whole cumulative", () => {
			const {events} = fold([
				fixtures.init,
				fixtures.responseDone,
				withoutNumTurns(fixtures.resultSuccess),
			]);
			// With the field present this is turn 1 and the cumulative is its own (20963/151). Absent,
			// the same cumulative could be a resumed child's whole conversation, so the steps are the
			// only grounded measure and the result adds nothing.
			expect(events.filter((event) => event.kind === "usage")).toHaveLength(1);
			expect(summed(events)).toEqual({inputTokens: 4481, outputTokens: 110});
		});

		it("reports a resumed child exactly as a numbered resumed child is reported", () => {
			const numbered = fold([
				fixtures.init,
				fixtures.censusResumedStep,
				fixtures.censusResumedResult,
			]);
			const {events} = fold([
				fixtures.init,
				fixtures.censusResumedStep,
				withoutNumTurns(fixtures.censusResumedResult),
			]);
			expect(summed(events)).toEqual(summed(numbered.events));
			expect(summed(events)).toEqual({inputTokens: 4861, outputTokens: 1});
		});

		it("keys two such turns apart, so the core keeps both instead of only the first", () => {
			// A residual needs a cumulative that outruns the turn's own steps, which the census numbers
			// never do — so each result here carries input tokens its step did not report.
			const overCumulative = (line: string, input: number, output: number): string =>
				patchResult(withoutNumTurns(line), {
					usage: {input_tokens: input, output_tokens: output, total_tokens: input + output},
				});
			const {events} = fold([
				fixtures.init,
				fixtures.censusTurnOneStep,
				withoutNumTurns(fixtures.censusTurnOneResult),
				fixtures.censusTurnTwoStep,
				overCumulative(fixtures.censusTurnTwoResult, 21419 + 100, 2),
				fixtures.censusResumedStep,
				overCumulative(fixtures.censusResumedResult, 26280 + 200, 3),
			]);
			const usage = events.filter((event) => event.kind === "usage");
			expect(usage.map((event) => event.turn)).toEqual([
				`agy:usage:${CENSUS_CONVERSATION}:step:1`,
				`agy:usage:${CENSUS_CONVERSATION}:step:3`,
				`agy:usage:${CENSUS_CONVERSATION}:turn-after-step:3`,
				`agy:usage:${CENSUS_CONVERSATION}:step:6`,
				`agy:usage:${CENSUS_CONVERSATION}:turn-after-step:6`,
			]);
			// Both residuals land: under one key per unknown turn the second is dropped by `addUsage`.
			const totals = usageTotals(usage.reduce(addUsage, emptyUsage));
			expect(totals).toMatchObject({inputTokens: 16771 + 4648 + 100 + 4861 + 100, outputTokens: 3});
		});
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

	/**
	 * `fixtures.resultInterrupted` is a verbatim capture of the terminal `result` a `SIGINT`'d turn
	 * emits — taken from a direct probe of agy v1.1.28, and the same shape
	 * [#8694](https://github.com/kamp-us/phoenix/issues/8694) recorded off a v1.1.27 desk run (that
	 * issue quotes the projection, `detail: "interrupted"`, rather than the whole line; the probe
	 * supplies the envelope around it). The mark is what #8693 was missing: the window renders the
	 * break off the transcript, so a stop with no row to mark leaves "Ready." and nothing else.
	 */
	describe("a turn the operator stopped", () => {
		it("marks the cut reply interrupted instead of failing the turn", () => {
			const {events} = fold([
				fixtures.init,
				fixtures.responseActive,
				patchResult(fixtures.resultInterrupted, {conversation_id: CONVERSATION}),
			]);
			expect(events.filter((event) => event.kind === "failure")).toEqual([]);
			const rendered = items(events);
			const cut = rendered.at(-1);
			expect(cut).toMatchObject({kind: "assistant", interrupted: true});
			// The same row the deltas streamed into, superseded rather than doubled.
			expect(cut?.id).toBe(rendered[0]?.id);
			expect(cut?.kind === "assistant" && cut.text).toContain("**5** files");
		});

		it("mints a row to carry the mark even when the reply had no text yet", () => {
			const rendered = items(fold([fixtures.init, fixtures.resultInterrupted]).events);
			expect(rendered).toEqual([
				expect.objectContaining({kind: "assistant", text: "", interrupted: true}),
			]);
		});

		it("still reports the stopped turn's usage, which agy does count", () => {
			const {events} = fold([fixtures.init, fixtures.resultInterrupted]);
			expect(summed(events)).toEqual({inputTokens: 16793, outputTokens: 1105});
		});

		it("reads any other ERROR as the failure it is", () => {
			const {events} = fold([
				patchResult(fixtures.resultInterrupted, {error: "timeout waiting for response"}),
			]);
			expect(events.at(-1)).toMatchObject({
				kind: "failure",
				failure: {tag: "AgyTurnFailed", detail: "timeout waiting for response"},
			});
			expect(items(events).some((item) => item.kind === "assistant" && item.interrupted)).toBe(
				false,
			);
		});
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
