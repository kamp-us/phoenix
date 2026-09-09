/**
 * The per-turn `result` fold every layer's event stream runs through (#8724).
 *
 * The cases are the whole contract: one result per turn, ahead of the event that closed it, and
 * none at all outside a turn — which is what keeps a session's open, whose own `ready` rides the
 * same stream, from publishing an answer nobody asked for.
 */

import {assert, describe, it} from "@effect/vitest";
import {INTERRUPT_ERROR} from "./core/failures.ts";
import type {AgentEvent} from "./events.ts";
import {type AssistantItem, ItemId, type ToolItem, type UserItem} from "./ports/index.ts";
import {betweenTurns, type TurnTracking, trackTurn} from "./turn-result.ts";

const prompt: UserItem = {kind: "user", id: ItemId.make("u1"), timestamp: 10, text: "hello"};

const reply = (text: string, partial?: true): AssistantItem => ({
	kind: "assistant",
	id: ItemId.make("a1"),
	timestamp: 11,
	text,
	...(partial === undefined ? {} : {partial}),
});

const tool = (status: ToolItem["status"], text: string): ToolItem => ({
	kind: "tool",
	id: ItemId.make("t1"),
	timestamp: 12,
	name: "read_file",
	input: {path: "README.md"},
	result: {text, omitted: {bytes: 0}},
	status,
});

const prompting = {kind: "phase", phase: "prompting"} as const;
const ready = {kind: "phase", phase: "ready"} as const;

/** Every event the fold emitted for this run, in order. */
const through = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<AgentEvent> => {
	let turn: TurnTracking = betweenTurns;
	const out: Array<AgentEvent> = [];
	for (const event of events) {
		const [next, emitted] = trackTurn(turn, event);
		turn = next;
		out.push(...emitted);
	}
	return out;
};

const resultsIn = (events: ReadonlyArray<AgentEvent>) =>
	through(events).filter((event) => event.kind === "result");

describe("the turn a layer brackets", () => {
	it("answers with the reply's text and the turn's items, ahead of the closing phase", () => {
		const out = through([
			prompting,
			{kind: "item", item: prompt},
			{kind: "item", item: reply("hi")},
			ready,
		]);
		assert.deepStrictEqual(out.at(-2), {
			kind: "result",
			result: {text: "hi", items: [prompt, reply("hi")], ok: true},
		});
		assert.deepStrictEqual(out.at(-1), ready);
	});

	it("carries one copy of an item the turn re-sent, as it last stood", () => {
		assert.deepStrictEqual(
			resultsIn([
				prompting,
				{kind: "item", item: tool("running", "")},
				{kind: "item", item: tool("ok", "# phoenix")},
				ready,
			]),
			[{kind: "result", result: {text: "", items: [tool("ok", "# phoenix")], ok: true}}],
		);
	});

	it("drops the streaming marker a turn that ended mid-frame left on its reply", () => {
		assert.deepStrictEqual(
			resultsIn([prompting, {kind: "item", item: reply("half", true)}, ready]),
			[{kind: "result", result: {text: "half", items: [reply("half")], ok: true}}],
		);
	});

	it("emits exactly one per turn, and one per turn of a session that ran two", () => {
		assert.lengthOf(resultsIn([prompting, {kind: "item", item: reply("one")}, ready]), 1);
		assert.lengthOf(
			resultsIn([prompting, ready, prompting, {kind: "item", item: reply("two")}, ready]),
			2,
		);
	});
});

describe("a turn that did not end well", () => {
	it("marks a turn a refusal landed in", () => {
		assert.deepStrictEqual(
			resultsIn([
				prompting,
				{
					kind: "failure",
					failure: {tag: "tuval/ai-agent/PromptError", reason: "refused", detail: "no"},
				},
				ready,
			]),
			[{kind: "result", result: {text: "", items: [], ok: false}}],
		);
	});

	it("marks a reply the backend flagged as cut short", () => {
		const cut: AssistantItem = {...reply("I was in the middle of"), interrupted: true};
		assert.deepStrictEqual(resultsIn([prompting, {kind: "item", item: cut}, ready]), [
			{kind: "result", result: {text: cut.text, items: [cut], ok: false}},
		]);
	});

	/**
	 * The one refusal that ends a turn with no phase behind it: the backend answering that there is
	 * nothing left to stop, which `foldInterruptRefusal` walks to `ready` on its own. A turn left
	 * open here would have its answer dropped by the next turn's `prompting`.
	 */
	it("closes a turn on the interrupt refusal that says the turn is already over", () => {
		assert.deepStrictEqual(
			resultsIn([
				prompting,
				{kind: "item", item: reply("done")},
				{kind: "failure", failure: {tag: INTERRUPT_ERROR, reason: "no-live-turn", detail: "gone"}},
			]),
			[{kind: "result", result: {text: "done", items: [reply("done")], ok: false}}],
		);
	});

	it("leaves a turn running when the refusal says the turn is still running", () => {
		const refused = {
			kind: "failure",
			failure: {tag: INTERRUPT_ERROR, reason: "turn-running", detail: "still writing"},
		} as const;
		assert.deepStrictEqual(
			resultsIn([prompting, refused, {kind: "item", item: reply("done")}, ready]),
			[{kind: "result", result: {text: "done", items: [reply("done")], ok: true}}],
		);
	});

	it("answers for the turn a transport that went away was in the middle of", () => {
		assert.deepStrictEqual(
			resultsIn([prompting, {kind: "item", item: reply("half")}, {kind: "phase", phase: "gone"}]),
			[{kind: "result", result: {text: "half", items: [reply("half")], ok: false}}],
		);
	});

	it("answers for the turn a local command ended, under the conversation that ran it", () => {
		const out = through([prompting, {kind: "session-reset", sessionId: "next"}]);
		assert.deepStrictEqual(out, [
			prompting,
			{kind: "result", result: {text: "", items: [], ok: true}},
			{kind: "session-reset", sessionId: "next"},
		]);
	});
});

describe("what is not a turn", () => {
	it("says nothing for an open, whose own ready rides the same stream", () => {
		assert.deepStrictEqual(resultsIn([{kind: "phase", phase: "starting"}, ready]), []);
	});

	it("says nothing for items arriving outside a turn", () => {
		assert.deepStrictEqual(resultsIn([{kind: "item", item: reply("replayed")}]), []);
	});

	it("adds none to a turn the layer answered itself", () => {
		const own = {kind: "result", result: {text: "mine", items: [], ok: true}} as const;
		assert.deepStrictEqual(resultsIn([prompting, own, ready]), [own]);
	});

	it("leaves the core's own phases alone", () => {
		assert.deepStrictEqual(
			through([prompting, {kind: "phase", phase: "reconnecting"}, ready]).length,
			4,
		);
	});
});
