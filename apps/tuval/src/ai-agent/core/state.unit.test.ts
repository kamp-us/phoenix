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
import {Mode, type ModelRef, type PermissionRequest} from "../ports/index.ts";
import {parseSessionState} from "./snapshot.ts";
import {
	type AiAgentSessionState,
	checkpointFields,
	checkpointWorthy,
	cutPromptId,
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

describe("the version slot the layers fill", () => {
	it("starts empty, because no layer has reported one yet", () => {
		expect(initialState("/repo").agentVersion).toBeNull();
	});

	it("comes back empty from a checkpoint, since the binary the layer launches can have moved", () => {
		expect(restore({...saved, agentVersion: "2.1.259"}).agentVersion).toBeNull();
	});

	it("refuses a saved value that is neither a string nor absent", () => {
		expect(parseSessionState({...saved, agentVersion: 2.1})).toBeNull();
	});
});

describe("the booted-on account slot", () => {
	const account = {organization: "kamp.us", subscriptionType: "max"};

	it("starts empty, because no layer has reported one yet", () => {
		expect(initialState("/repo").account).toBeNull();
	});

	it("round-trips through JSON with either field present or absent", () => {
		for (const carried of [account, {organization: "kamp.us"}, {subscriptionType: "max"}, {}]) {
			const withAccount = {...saved, account: carried};
			expect(parseSessionState(JSON.parse(JSON.stringify(withAccount)))).toEqual(withAccount);
		}
	});

	// The operator can log into the other account while the desk is off, and the row exists to
	// answer which one this session bills — so the previous process's answer is the wrong one.
	it("comes back empty from a checkpoint, since the login can have moved", () => {
		expect(restore({...saved, account}).account).toBeNull();
	});

	it("refuses a saved shape that is not an account", () => {
		expect(parseSessionState({...saved, account: {organization: 7}})).toBeNull();
		expect(parseSessionState({...saved, account: "kamp.us"})).toBeNull();
	});

	// The founder's org-and-plan-only ruling, held at the parse boundary: nothing in this process
	// can write an email into the slot, so a checkpoint carrying one is not this program's.
	it("refuses a saved account carrying an email", () => {
		expect(
			parseSessionState({...saved, account: {...account, email: "someone@example.com"}}),
		).toBeNull();
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

	// A turn whose content was tool calls alone draws no assistant row (#8216), so a scan that ran
	// past the operator's prompt would answer with the *previous* turn's finished reply.
	it("stops at the newest prompt, so a tool-only turn names no cut reply", () => {
		expect(
			lastAssistantId([userItem("i0"), assistantItem("i1"), userItem("i2"), toolItem("i3")]),
		).toBeNull();
	});

	// The resend anchor (#8699). It answers on every tail the reply-scan above answers `null` for,
	// which is the whole point: no assistant item is needed to get a marker.
	it("names the newest prompt, whatever the turn above it wrote", () => {
		expect(cutPromptId([userItem("i0"), assistantItem("i1"), toolItem("i2")])).toBe("i0");
		expect(cutPromptId([userItem("i0"), assistantItem("i1"), userItem("i2"), toolItem("i3")])).toBe(
			"i2",
		);
		expect(cutPromptId([userItem("i0")])).toBe("i0");
	});

	it("answers nothing only for a tail holding no prompt at all", () => {
		expect(cutPromptId([])).toBeNull();
		expect(cutPromptId([assistantItem("i1"), toolItem("i2")])).toBeNull();
	});
});

/**
 * #8634: the catalogs are checkpointed, so a session saved at `gone` would otherwise come back off
 * disk offering the rows of a session that is over — and `offerResolved` reads `gone` as resolved.
 */
describe("a restored session and its offered catalogs", () => {
	const opus: ModelRef = {provider: "anthropic", id: "claude-opus-5", name: "Opus 5"};
	const sonnet: ModelRef = {provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5"};
	const offering: AiAgentSessionState = {
		...initialState("/repo"),
		modes: {current: Mode.make("plan"), available: [Mode.make("plan"), Mode.make("build")]},
		models: {current: opus, available: [opus, sonnet]},
		commands: [{name: "compact", description: "Summarise the conversation."}],
		thinking: {current: "medium", available: ["low", "medium", "high"]},
	};

	it("comes back offering nothing when the checkpoint was saved at gone", () => {
		const back = restore({...offering, phase: "gone"});
		expect(back.phase).toBe("gone");
		expect(back.models.available).toEqual([]);
		expect(back.thinking.available).toEqual([]);
		expect(back.modes.available).toEqual([]);
		expect(back.commands).toEqual([]);
	});

	// The selection does not go with the catalog: it is the operator's, re-validated at the next
	// open against whatever that session reads (#7981).
	it("keeps the operator's held picks beside the empty offer", () => {
		const back = restore({...offering, phase: "gone"});
		expect(back.models.current).toEqual(opus);
		expect(back.thinking.current).toBe("medium");
		expect(back.modes.current).toBe(Mode.make("plan"));
	});

	// Any other phase comes back `idle`, where `offerResolved` is false, so nothing paints these
	// rows before the reconnect re-announces what the session offers.
	it("keeps them intact when the checkpoint restores to idle", () => {
		for (const phase of ["ready", "prompting", "reconnecting", "starting", "idle"] as const) {
			const back = restore({...offering, phase});
			expect(back.phase).toBe("idle");
			expect(back.models.available).toEqual([opus, sonnet]);
			expect(back.thinking.available).toEqual(["low", "medium", "high"]);
			expect(back.modes.available).toHaveLength(2);
			expect(back.commands).toHaveLength(1);
		}
	});
});
