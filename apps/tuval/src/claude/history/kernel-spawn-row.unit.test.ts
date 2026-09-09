/**
 * A kernel spawn opening a row in its parent's list (#8719), over the Claude mapping.
 *
 * **What is captured here and what is not.** The envelopes are `tool-turn.json`'s, captured off a
 * real `query()` run (`fixtures/PROVENANCE.md`); this file re-keys exactly two things inside them —
 * the tool's name and input on the call, and the result text on its answer — because no `query()`
 * capture can carry a kernel spawn without a live Tuval MCP server on the other end. The shapes
 * being asserted are the captured ones; the tool's identity is the part stated here, and it is
 * stated once, in `spawnTurn` below.
 */

import type {SDKMessage} from "@anthropic-ai/claude-agent-sdk";
import {describe, expect, it} from "vitest";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {toAgentEvents} from "./events.ts";
import {loadFixture} from "./fixtures/load.ts";
import {emptyMapping, type Mapping, type MappingStep} from "./map.ts";

const AT = 1_700_000_000_000;

const run = (stream: ReadonlyArray<SDKMessage>) => {
	const events: AgentEvent[] = [];
	let current: Mapping = emptyMapping;
	for (const one of stream) {
		const step: MappingStep = toAgentEvents(one, current, {at: AT});
		current = step.mapping;
		events.push(...step.events);
	}
	return {events, mapping: current};
};

const slots = (events: ReadonlyArray<AgentEvent>) =>
	events.flatMap((event) => (event.kind === "subagent" ? [event.slot] : []));

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/** Re-key one captured frame: the call's tool identity, and the answer its result carries. */
const rekey = (frame: unknown, name: string, result: unknown): void => {
	if (!isRecord(frame)) return;
	const message = frame.message;
	const content = isRecord(message) ? message.content : undefined;
	for (const block of Array.isArray(content) ? content : []) {
		if (!isRecord(block)) continue;
		if (block.type === "tool_use") {
			block.name = name;
			block.input = {program: "tuval/claude"};
		}
		if (block.type === "tool_result") block.content = result;
	}
	if (frame.tool_use_result !== undefined) frame.tool_use_result = result;
};

/** The captured tool turn with its one call re-keyed to the kernel's spawn tool and its answer. */
const spawnTurn = (result: unknown, name = "mcp__tuval__spawn"): ReadonlyArray<SDKMessage> => {
	const stream = structuredClone(loadFixture("tool-turn")) as ReadonlyArray<SDKMessage>;
	for (const frame of stream) rekey(frame, name, result);
	return stream;
};

describe("a kernel spawn in a Claude turn", () => {
	it("opens one slot naming the process the kernel answered with, and the program", () => {
		const opened = slots(run(spawnTurn('{"process":"p-9"}')).events);
		expect(opened).toHaveLength(1);
		expect(opened[0]).toMatchObject({
			id: "toolu_00000000000000000010",
			type: "tuval/claude",
			process: "p-9",
			tokens: 0,
			items: [],
		});
	});

	// The call settles the instant the child lands, and settling a call is what ends a worker's slot
	// here — so a slot opened before that pass would be `finished` on the frame it appeared.
	it("leaves that slot running, because the spawning call settling is not the child ending", () => {
		const opened = slots(run(spawnTurn('{"process":"p-9"}')).events);
		expect(opened.at(-1)?.status).toBe("running");
	});

	it("keeps the row at the call's own clock, not at its answer's", () => {
		const opened = slots(run(spawnTurn('{"process":"p-9"}')).events);
		expect(opened[0]?.startedAt).toBe(Date.parse("2026-09-04T18:23:24.205Z"));
	});

	it("opens nothing for another tool, and nothing when the answer named no process", () => {
		expect(slots(run(spawnTurn('{"process":"p-9"}', "Bash")).events)).toEqual([]);
		expect(slots(run(spawnTurn("started it")).events)).toEqual([]);
	});
});
