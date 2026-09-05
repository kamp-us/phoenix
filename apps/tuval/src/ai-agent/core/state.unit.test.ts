/**
 * The checkpoint half: what a save carries, what a load refuses, and what a load does to a state
 * that was mid-turn when the process went away.
 */

import {describe, expect, it} from "vitest";
import {assistantItem, toolItem, userItem} from "../../ai-agent-fixtures/transcripts.ts";
import type {Phase} from "../events.ts";
import {Mode, type PermissionRequest} from "../ports/index.ts";
import {parseSessionState} from "./snapshot.ts";
import {
	type AiAgentSessionState,
	initialState,
	lastAssistantId,
	phases,
	replyPending,
	restore,
} from "./state.ts";

/** Every `Phase` is in `phases`; flipping this reds with TS2322 at this line. */
const everyPhaseListed: Phase extends (typeof phases)[number] ? true : false = true;

const card: PermissionRequest = {
	title: "Write README.md",
	displayName: "write_file",
	description: "Create a file in the working directory",
	input: {path: "README.md", contents: "hello"},
	offersAlways: true,
};

const saved: AiAgentSessionState = {
	...initialState("/repo"),
	phase: "prompting",
	sessionId: "session-1",
	transcript: {
		items: [userItem("i0"), assistantItem("i1"), toolItem("i2")],
		omitted: {items: 3, bytes: 120, reason: "item-limit"},
	},
	usage: {model: "claude-opus-5", inputTokens: 1_200, outputTokens: 340, cost: 0.031},
	permissions: {"req-1": card},
	modes: {current: Mode.make("plan"), available: [Mode.make("plan"), Mode.make("build")]},
	lastPrompt: "make the README",
	lastPage: {items: [userItem("older-0")], hasMore: true},
	failure: {tag: "tuval/ai-agent/PromptError", reason: "disconnected", detail: "socket closed"},
};

describe("a save snapshot", () => {
	it("round-trips through JSON with its permission cards and usage intact", () => {
		const parsed = parseSessionState(JSON.parse(JSON.stringify(saved)));
		expect(parsed).toEqual(saved);
		expect(parsed?.permissions["req-1"]).toEqual(card);
		expect(parsed?.usage).toEqual(saved.usage);
	});

	it("lists every phase the type admits", () => {
		expect(everyPhaseListed).toBe(true);
		expect([...phases]).toEqual(["idle", "starting", "ready", "prompting", "reconnecting", "gone"]);
	});

	it("refuses a shape it cannot read, with null rather than a throw", () => {
		expect(parseSessionState({...saved, phase: "thinking"})).toBeNull();
		expect(parseSessionState({...saved, usage: {model: "m"}})).toBeNull();
		expect(parseSessionState({...saved, permissions: {"req-1": {title: "no fields"}}})).toBeNull();
		expect(
			parseSessionState({...saved, transcript: {items: [{kind: "user"}], omitted: null}}),
		).toBeNull();
		expect(parseSessionState("not a state")).toBeNull();
	});
});

describe("restoring a saved session", () => {
	it("marks the turn a restart cut and comes back reconnecting", () => {
		const restored = restore(saved);
		expect(restored.phase).toBe("reconnecting");
		expect(restored.interrupted).toBe("i1");
	});

	it("leaves a completed turn alone", () => {
		const completed: AiAgentSessionState = {
			...saved,
			transcript: {...saved.transcript, items: [userItem("i0"), assistantItem("i1")]},
		};
		expect(restore(completed)).toEqual(completed);
	});

	it("leaves a session that was not mid-turn alone", () => {
		const idle: AiAgentSessionState = {...saved, phase: "ready"};
		expect(restore(idle)).toEqual(idle);
	});

	it("marks nothing when the cut turn had no assistant item before it", () => {
		const firstTurn: AiAgentSessionState = {
			...saved,
			transcript: {...saved.transcript, items: [userItem("i0")]},
		};
		expect(restore(firstTurn).interrupted).toBeNull();
		expect(restore(firstTurn).phase).toBe("reconnecting");
	});
});

describe("reading the tail", () => {
	it("names the newest assistant turn, or none", () => {
		expect(lastAssistantId([userItem("i0"), assistantItem("i1"), toolItem("i2")])).toBe("i1");
		expect(lastAssistantId([userItem("i0")])).toBeNull();
		expect(lastAssistantId([])).toBeNull();
	});

	it("calls a reply pending only when the tail ends on something else", () => {
		expect(replyPending([userItem("i0"), assistantItem("i1")])).toBe(false);
		expect(replyPending([assistantItem("i1"), toolItem("i2")])).toBe(true);
		expect(replyPending([])).toBe(false);
	});
});
