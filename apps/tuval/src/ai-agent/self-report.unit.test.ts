/**
 * The two lines an AI-agent process says about itself, as pure functions of committed state.
 *
 * Every case here is one a real session reaches: no model yet, a model switched, a tool row at the
 * bottom, a reply written over several lines, and a cost nobody has reported.
 */

import {describe, expect, it} from "vitest";
import {type AiAgentSessionState, initialState} from "./core/index.ts";
import type {ItemId, ModelRef, TranscriptItem} from "./ports/index.ts";
import {agentLastLine, agentStatus, agentTitle, STATUS_LINE_LIMIT} from "./self-report.ts";

const id = (value: string): ItemId => value as ItemId;

const opus: ModelRef = {provider: "anthropic", id: "claude-opus-5", name: "Opus 5"};
const sonnet: ModelRef = {provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5"};

const session = (
	over: Partial<AiAgentSessionState> = {},
	cwd = "/Users/kim/code/phoenix",
): AiAgentSessionState => ({...initialState(cwd), ...over});

const on = (model: ModelRef | null): Partial<AiAgentSessionState> => ({
	models: {current: model, available: [opus, sonnet]},
});

const said = (...items: ReadonlyArray<TranscriptItem>): Partial<AiAgentSessionState> => ({
	transcript: {items, omitted: {items: 0, bytes: 0, reason: "none"}},
});

const reply = (text: string): TranscriptItem => ({
	kind: "assistant",
	id: id("a1"),
	timestamp: 1,
	text,
});

const spent = (cost: number): Partial<AiAgentSessionState> => ({
	usage: {model: opus.id, turns: {"turn-1": {inputTokens: 10, outputTokens: 4, cost}}},
});

describe("the title an AI-agent process publishes", () => {
	it("names the program, the model and the folder", () => {
		expect(agentTitle("claude-session", session(on(opus)))).toBe(
			"claude-session · Opus 5 · phoenix",
		);
	});

	it("says the new model the moment the session is switched onto it", () => {
		const before = session(on(opus));
		expect(agentTitle("claude-session", {...before, ...on(sonnet)})).toBe(
			"claude-session · Sonnet 5 · phoenix",
		);
	});

	it("leaves the segment out rather than blank when no model has been named yet", () => {
		expect(agentTitle("claude-session", session(on(null)))).toBe("claude-session · phoenix");
	});

	it("answers the whole path for a root cwd, which has no last segment", () => {
		expect(agentTitle("counter", session(on(null), "/"))).toBe("counter · /");
	});
});

describe("the status an AI-agent process publishes", () => {
	it("carries the last line and the cost", () => {
		expect(agentStatus(session({...said(reply("wrote the test")), ...spent(0.0142)}))).toBe(
			"wrote the test · $0.0142",
		);
	});

	it("is the cost alone before the session has said anything", () => {
		expect(agentStatus(session())).toBe("$0.00");
	});

	it("reads a multi-line reply's last line, not its first", () => {
		expect(agentLastLine(session(said(reply("looked at rows.ts\n\nfound the off-by-one  "))))).toBe(
			"found the off-by-one",
		);
	});

	it("reads a tool row as its name, because its result is a body and not a line", () => {
		expect(
			agentLastLine(
				session(
					said({
						kind: "tool",
						id: id("t1"),
						timestamp: 2,
						name: "Read",
						input: {path: "rows.ts"},
						result: {text: "a thousand lines", omitted: {bytes: 0}},
						status: "ok",
					}),
				),
			),
		).toBe("Read");
	});

	it("cuts a long line to one line's worth", () => {
		const line = agentLastLine(session(said(reply("x".repeat(400)))));
		expect(line).toHaveLength(STATUS_LINE_LIMIT);
		expect(line.endsWith("…")).toBe(true);
	});

	it("says nothing for a row whose text is only whitespace", () => {
		expect(agentLastLine(session(said(reply("  \n\n  "))))).toBe("");
	});
});
