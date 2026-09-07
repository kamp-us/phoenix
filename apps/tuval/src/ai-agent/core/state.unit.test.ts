/**
 * The checkpoint half: what a save carries, what a load refuses, and what a load does to a state
 * that was mid-turn when the process went away.
 */

import {describe, expect, it} from "vitest";
import {pendingPermission} from "../../ai-agent-fixtures/permissions.ts";
import {
	assistantItem,
	subagentSlot,
	thinkingItem,
	toolItem,
	userItem,
} from "../../ai-agent-fixtures/transcripts.ts";
import type {Phase} from "../events.ts";
import {Mode, type PermissionRequest} from "../ports/index.ts";
import {parseSessionState} from "./snapshot.ts";
import {
	type AiAgentSessionState,
	checkpointFields,
	checkpointWorthy,
	initialState,
	lastAssistantId,
	phases,
	restore,
} from "./state.ts";

/** Every `Phase` is in `phases`; flipping this reds with TS2322 at this line. */
const everyPhaseListed: Phase extends (typeof phases)[number] ? true : false = true;

/** A field on the state that nobody decided about reds here with TS2322 (#8095's rule). */
const everyFieldDecided: Exclude<
	keyof AiAgentSessionState,
	(typeof checkpointFields)[number]
> extends never
	? true
	: false = true;

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
	usage: {
		model: "claude-opus-5",
		turns: {i1: {inputTokens: 1_200, outputTokens: 340, cost: 0.031}},
	},
	permissions: {"req-1": pendingPermission({request: card, seq: 3})},
	permissionsRaised: 3,
	modes: {current: Mode.make("plan"), available: [Mode.make("plan"), Mode.make("build")]},
	lastPrompt: "make the README",
	lastPage: {items: [userItem("older-0")], hasMore: true},
	failure: {tag: "tuval/ai-agent/PromptError", reason: "disconnected", detail: "socket closed"},
};

describe("a save snapshot", () => {
	it("round-trips through JSON with its permission cards and usage intact", () => {
		const parsed = parseSessionState(JSON.parse(JSON.stringify(saved)));
		expect(parsed).toEqual(saved);
		expect(parsed?.permissions["req-1"]?.request).toEqual(card);
		expect(parsed?.usage).toEqual(saved.usage);
	});

	it("names every field of the state, so none lands without a decision", () => {
		expect(everyFieldDecided).toBe(true);
		expect(Object.keys(initialState("/repo")).sort()).toEqual([...checkpointFields].sort());
		expect(checkpointFields).toContain("subagents");
	});

	it("carries the subagent slots, and refuses a saved set that is not slots", () => {
		const withSlots = {...saved, subagents: {"call-1": subagentSlot("call-1")}};
		expect(parseSessionState(JSON.parse(JSON.stringify(withSlots)))).toEqual(withSlots);
		expect(
			parseSessionState({...saved, subagents: {"call-1": {type: "general-purpose"}}}),
		).toBeNull();
		expect(parseSessionState({...saved, subagents: [subagentSlot("call-1")]})).toBeNull();
	});

	it("lists every phase the type admits", () => {
		expect(everyPhaseListed).toBe(true);
		expect([...phases]).toEqual(["idle", "starting", "ready", "prompting", "reconnecting", "gone"]);
	});

	it("refuses a shape it cannot read, with null rather than a throw", () => {
		expect(parseSessionState({...saved, phase: "thinking"})).toBeNull();
		expect(parseSessionState({...saved, usage: {model: "m"}})).toBeNull();
		expect(parseSessionState({...saved, permissions: {"req-1": {title: "no fields"}}})).toBeNull();
		// A card with no answering state at all is the pre-#8006 shape, and it is not readable.
		expect(parseSessionState({...saved, permissions: {"req-1": card}})).toBeNull();
		expect(
			parseSessionState({
				...saved,
				permissions: {"req-1": {request: card, seq: 1, progress: {status: "sent"}}},
			}),
		).toBeNull();
		expect(
			parseSessionState({...saved, transcript: {items: [{kind: "user"}], omitted: null}}),
		).toBeNull();
		expect(parseSessionState("not a state")).toBeNull();
	});
});

describe("a restored session and its subagents", () => {
	const items = [userItem("u1"), assistantItem("a1")];
	const loaded: AiAgentSessionState = {
		...initialState("/repo"),
		phase: "ready",
		subagents: {
			"call-1": subagentSlot("call-1", {items}),
			"call-2": subagentSlot("call-2", {status: "finished"}),
		},
	};

	it("brings every worker back not running, because nothing is pumping one", () => {
		const back = restore(loaded);
		expect(Object.values(back.subagents).map((slot) => slot.status)).toEqual([
			"finished",
			"finished",
		]);
	});

	it("keeps the rows a worker collected, so a view open on it is not blanked", () => {
		expect(restore(loaded).subagents["call-1"]?.items).toEqual(items);
	});

	// A restore is terminal like `gone` and not a per-turn failure: the process that was running
	// these turns is gone, so a row left `pending` waits for a turn nobody will narrate (#8236).
	it("brings every send that was in flight back uncertain, however far its turn had got", () => {
		const back = restore({
			...loaded,
			phase: "prompting",
			sends: [
				{key: "first", state: "pending", turn: "running"},
				{key: "second", state: "pending", turn: "unstarted"},
			],
		});
		expect(back.sends).toEqual([
			{key: "first", state: "uncertain", failure: null},
			{key: "second", state: "uncertain", failure: null},
		]);
	});
});

// #8160's coalescing, extended rather than joined by a second throttle: the two fields that move
// per frame are the two the gate reads.
describe("what is worth a checkpoint write", () => {
	const base = initialState("/repo");
	const holding = (...slots: ReadonlyArray<ReturnType<typeof subagentSlot>>) => ({
		...base,
		subagents: Object.fromEntries(slots.map((slot) => [slot.id, slot])),
	});

	it("refuses a state whose running worker only moved its last line or its tokens", () => {
		const running = holding(subagentSlot("call-1"));
		expect(checkpointWorthy(running)).toBe(false);
		expect(checkpointWorthy(holding(subagentSlot("call-1", {lastLine: "reading rows.ts"})))).toBe(
			false,
		);
		expect(checkpointWorthy(holding(subagentSlot("call-1", {tokens: 340_000})))).toBe(false);
	});

	it("admits the state once that worker has finished", () => {
		expect(checkpointWorthy(holding(subagentSlot("call-1", {status: "finished"})))).toBe(true);
	});

	it("refuses while any one of several workers is still running", () => {
		const mixed = holding(subagentSlot("call-1", {status: "finished"}), subagentSlot("call-2"));
		expect(checkpointWorthy(mixed)).toBe(false);
	});

	it("still refuses a partial item, with or without a worker", () => {
		const partial = {
			...base,
			transcript: {
				...base.transcript,
				items: [{...assistantItem("a1"), partial: true}],
			},
		};
		expect(checkpointWorthy(partial)).toBe(false);
		expect(checkpointWorthy(base)).toBe(true);
	});

	// The gate reads the marker through `in`, so reasoning growing one costs it no arm (#8288).
	it("refuses a state whose reasoning is still being written", () => {
		const reasoning = {
			...base,
			transcript: {...base.transcript, items: [{...thinkingItem("k1"), partial: true}]},
		};
		expect(checkpointWorthy(reasoning)).toBe(false);
		expect(checkpointWorthy({...reasoning, transcript: {...base.transcript}})).toBe(true);
	});
});

describe("reading the tail", () => {
	it("names the newest assistant turn, or none", () => {
		expect(lastAssistantId([userItem("i0"), assistantItem("i1"), toolItem("i2")])).toBe("i1");
		expect(lastAssistantId([userItem("i0")])).toBeNull();
		expect(lastAssistantId([])).toBeNull();
	});
});
