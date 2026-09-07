/**
 * The revision fold, over hand-built wire values rather than a live session: this is the one place
 * a Pi snapshot becomes something the window can render, so every case it has to get right is
 * cheaper to pin here than to provoke out of a model.
 */

import {applyCellChecked} from "@demlik/tea";
import type {
	TranscriptItem as PiTranscriptItem,
	SessionSnapshot,
} from "@earendil-works/pi-protocol";
import {describe, expect, it} from "vitest";
import {
	type AiAgentSessionCmd,
	type AiAgentSessionMsg,
	type AiAgentSessionState,
	aiAgentSessionMachine,
	holdsPartialItem,
	initialState,
} from "../../ai-agent/core/index.ts";
import type {AgentEvent} from "../../ai-agent/events.ts";
import {TOOL_RESULT_BYTE_LIMIT, type TranscriptItem} from "../../ai-agent/ports/index.ts";
import {
	emptyProjection,
	eventsOf,
	itemId,
	itemOf,
	itemsOf,
	phaseOf,
	projectionOf,
} from "./items.ts";

/**
 * The tail an operator holds who read this snapshot as far as `through`: the rows the fold would
 * have emitted, in that order. `projectionOf` takes the tail rather than a boundary id, because
 * "already read" is measured against the copies in it.
 */
const heldThrough = (source: SessionSnapshot, through: string): ReadonlyArray<TranscriptItem> => {
	const rows: Array<TranscriptItem> = [];
	for (const item of source.transcript) {
		for (const row of itemsOf(item)) {
			rows.push(row);
			if (row.id === through) return rows;
		}
	}
	return rows;
};

const usage = (total: number) => ({
	input: 11,
	output: 22,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 33,
	cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total},
});

const snapshot = (
	transcript: ReadonlyArray<PiTranscriptItem>,
	phase: SessionSnapshot["phase"] = "idle",
	revision = 1,
): SessionSnapshot => ({
	id: "session-7602",
	cwd: "/workspace",
	createdAt: 0,
	updatedAt: 0,
	phase,
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
	attached: true,
	locked: false,
	revision,
	transcript: [...transcript],
	queuedSteer: [],
	queuedSteerCount: 0,
});

const user: PiTranscriptItem = {
	id: "item-0",
	role: "user",
	content: [{type: "text", text: "say hello"}],
	timestamp: 10,
};

const assistant = (text: string, total = 0): PiTranscriptItem => ({
	id: "item-1",
	role: "assistant",
	content: [
		{type: "thinking", thinking: "not for the window"},
		{type: "text", text},
	],
	model: {provider: "faux", id: "faux-1"},
	usage: usage(total),
	timestamp: 11,
	status: "complete",
	stopReason: "stop",
});

/**
 * The same turn twice: mid-flight, then settled. Pi ids items positionally over
 * `[...messages, streaming]` (`../server/transcript.ts`), and the in-flight message lands on
 * `messages` under the index it already occupied — so the pair shares one id by construction.
 */
const streamingAssistant = (text: string): PiTranscriptItem => ({
	id: "item-1",
	role: "assistant",
	content: [{type: "text", text}],
	model: {provider: "faux", id: "faux-1"},
	timestamp: 11,
	status: "streaming",
});

const settledAssistant = (text: string): PiTranscriptItem => ({
	id: "item-1",
	role: "assistant",
	content: [{type: "text", text}],
	model: {provider: "faux", id: "faux-1"},
	timestamp: 11,
	status: "complete",
	stopReason: "stop",
});

const runningTool: PiTranscriptItem = {
	id: "item-2",
	role: "tool",
	toolCallId: "call-1",
	toolName: "read_file",
	input: {path: "README.md"},
	content: [],
	timestamp: 12,
	status: "running",
	isError: false,
};

const settledTool: PiTranscriptItem = {
	...runningTool,
	content: [{type: "text", text: "the file"}],
	status: "complete",
	isError: false,
};

describe("one wire item as a port item", () => {
	it("keeps a user turn's text and drops nothing else", () => {
		expect(itemOf(user)).toEqual({kind: "user", id: "item-0", timestamp: 10, text: "say hello"});
	});

	it("leaves an assistant turn's thinking out of the text it renders", () => {
		expect(itemOf(assistant("hi back"))).toEqual({
			kind: "assistant",
			id: "item-1",
			timestamp: 11,
			text: "hi back",
		});
	});

	it("gives that thinking a row of its own, ahead of the reply it produced", () => {
		expect(itemsOf(assistant("hi back"))).toEqual([
			{kind: "thinking", id: "item-1:thinking", timestamp: 11, text: "not for the window"},
			{kind: "assistant", id: "item-1", timestamp: 11, text: "hi back"},
		]);
	});

	it("draws no reasoning row for a turn that carries none", () => {
		const plain: PiTranscriptItem = {
			...assistant("hi back"),
			content: [{type: "text", text: "hi back"}],
		};
		expect(itemsOf(plain)).toEqual([itemOf(plain)]);
		expect(itemsOf(user)).toEqual([itemOf(user)]);
		expect(itemsOf(runningTool)).toEqual([itemOf(runningTool)]);
	});

	it("marks an aborted turn interrupted", () => {
		const aborted: PiTranscriptItem = {
			id: "item-1",
			role: "assistant",
			content: [{type: "text", text: "half a th"}],
			model: {provider: "faux", id: "faux-1"},
			timestamp: 11,
			status: "aborted",
			stopReason: "aborted",
		};
		expect(itemOf(aborted)).toEqual({
			kind: "assistant",
			id: "item-1",
			timestamp: 11,
			text: "half a th",
			interrupted: true,
		});
	});

	it("marks a reply still being written, and drops the marker when it settles", () => {
		const inFlight = itemOf(streamingAssistant("hi"));
		const settled = itemOf(settledAssistant("hi back"));
		expect(inFlight).toEqual({
			kind: "assistant",
			id: "item-1",
			timestamp: 11,
			text: "hi",
			partial: true,
		});
		expect(settled).toEqual({kind: "assistant", id: "item-1", timestamp: 11, text: "hi back"});
		expect(settled.id, "the settled turn lands under a second id and the window keeps both").toBe(
			inFlight.id,
		);
		expect("partial" in settled).toBe(false);
	});

	it("leaves no partial on a transcript nothing is in flight in", () => {
		const items = [user, settledAssistant("hi back"), settledTool].flatMap(itemsOf);
		expect(items.some((item) => "partial" in item)).toBe(false);
	});

	it("keys a tool row by its call id and folds the three wire statuses", () => {
		expect(itemOf(runningTool)).toEqual({
			kind: "tool",
			id: "call-1",
			timestamp: 12,
			name: "read_file",
			input: {path: "README.md"},
			result: {text: "", omitted: {bytes: 0}},
			status: "running",
		});
		expect(itemOf(settledTool)).toMatchObject({id: "call-1", status: "ok"});
		expect(itemOf({...settledTool, status: "error", isError: true})).toMatchObject({
			status: "error",
		});
	});

	it("bounds a tool result at the port's byte limit", () => {
		const long = {...settledTool, content: [{type: "text" as const, text: "x".repeat(20_000)}]};
		const bounded = itemOf(long);
		expect(bounded.kind).toBe("tool");
		if (bounded.kind !== "tool") return;
		expect(bounded.result.text.length).toBeLessThanOrEqual(TOOL_RESULT_BYTE_LIMIT);
		expect(bounded.result.omitted.bytes).toBeGreaterThan(0);
	});
});

describe("Pi's phases against the core's", () => {
	it("reads idle as ready and every busy phase as prompting", () => {
		expect(phaseOf("idle")).toBe("ready");
		const busy: ReadonlyArray<SessionSnapshot["phase"]> = [
			"turn",
			"compaction",
			"branch_summary",
			"retry",
		];
		expect(busy.map(phaseOf)).toEqual(["prompting", "prompting", "prompting", "prompting"]);
	});
});

describe("one revision folded into events", () => {
	it("emits every item, then usage, then the phase", () => {
		const folded = eventsOf(emptyProjection, snapshot([user, assistant("hi back", 0.42)], "idle"));
		expect(folded.events.map((event) => event.kind)).toEqual([
			"item",
			"item",
			"item",
			"usage",
			"phase",
		]);
		expect(folded.events.at(-2)).toEqual({
			kind: "usage",
			turn: "item-1",
			model: "faux/faux-1",
			inputTokens: 11,
			outputTokens: 22,
			cost: 0.42,
		});
		expect(folded.events.at(-1)).toEqual({kind: "phase", phase: "ready"});
	});

	it("re-emits nothing when the next revision changed nothing", () => {
		const first = eventsOf(emptyProjection, snapshot([user, assistant("hi back")]));
		const second = eventsOf(first.next, snapshot([user, assistant("hi back")], "idle", 2));
		expect(second.events).toEqual([]);
	});

	/**
	 * A resume opens a fresh fold over a transcript the operator is already reading, so the seed
	 * off the attach lease's snapshot has to make Pi's next whole-transcript push a no-op: no
	 * `item`, so nothing is appended after the operator's own turn and pushed out of the window's
	 * 40-item cut, and no `usage`, so the session's totals are not re-added (#8369).
	 */
	it("emits no item and no usage when a resume's seed already holds the whole transcript", () => {
		const restored = snapshot([user, assistant("hi back", 0.42)], "idle", 7);
		const folded = eventsOf(projectionOf(restored, heldThrough(restored, "item-1")), restored);
		expect(folded.events).toEqual([{kind: "phase", phase: "ready"}]);
	});

	it("emits only the operator's own turn on the first push after a resume", () => {
		const restored = snapshot([user, assistant("hi back", 0.42)], "idle", 7);
		const sent: PiTranscriptItem = {
			id: "item-3",
			role: "user",
			content: [{type: "text", text: "and again"}],
			timestamp: 13,
		};
		const folded = eventsOf(
			projectionOf(restored, heldThrough(restored, "item-1")),
			snapshot([user, assistant("hi back", 0.42), sent], "turn", 8),
		);
		expect(folded.events).toEqual([
			{kind: "item", item: itemOf(sent)},
			{kind: "phase", phase: "prompting"},
		]);
	});

	/**
	 * Everything after the boundary is work the caller has never seen — a turn the session finished
	 * while the socket was down — and burying it would leave no gap marker and no way to page to it
	 * (#8374).
	 */
	it("emits what the session finished past the boundary the caller holds", () => {
		const restored = snapshot([user, assistant("hi back", 0.42)], "idle", 7);
		const folded = eventsOf(projectionOf(restored, heldThrough(restored, user.id)), restored);
		expect(folded.events).toEqual([
			{
				kind: "item",
				item: {kind: "thinking", id: "item-1:thinking", timestamp: 11, text: "not for the window"},
			},
			{kind: "item", item: itemOf(assistant("hi back", 0.42))},
			{
				kind: "usage",
				turn: "item-1",
				model: "faux/faux-1",
				inputTokens: 11,
				outputTokens: 22,
				cost: 0.42,
			},
			{kind: "phase", phase: "ready"},
		]);
	});

	/**
	 * The socket can drop between a turn's reasoning row and its reply, so the boundary lands
	 * inside the turn rather than after it. The reply is then unseen work that has to emit — and
	 * its cost is that reply's annotation, so the turn's `usage` has to emit with it or the tokens
	 * and the cost never join the session totals, silently, for the life of the session (#8374).
	 */
	it("emits the cost of a turn the boundary fell inside, not just its reply", () => {
		const restored = snapshot([user, assistant("hi back", 0.42)], "idle", 7);
		const folded = eventsOf(
			projectionOf(restored, heldThrough(restored, "item-1:thinking")),
			restored,
		);
		expect(folded.events).toEqual([
			{kind: "item", item: itemOf(assistant("hi back", 0.42))},
			{
				kind: "usage",
				turn: "item-1",
				model: "faux/faux-1",
				inputTokens: 11,
				outputTokens: 22,
				cost: 0.42,
			},
			{kind: "phase", phase: "ready"},
		]);
	});

	/**
	 * The boundary can land *on* a row whose content moved while the socket was down. Pi's
	 * assistant item has a `status: "streaming"` variant with `usage` optional
	 * (`@earendil-works/pi-protocol` 0.84.3 `dist/schemas.d.ts`), so a reply the drop caught
	 * mid-write settles server-side while this process is away. Being at the boundary does not
	 * make it read: the operator holds the half-written copy, so the settled one has to emit, and
	 * the turn's cost with it.
	 */
	it("emits a row that settled under the boundary while the caller was away", () => {
		const restored = snapshot([user, assistant("hi back", 0.42)], "idle", 7);
		const streaming: PiTranscriptItem = {
			id: "item-1",
			role: "assistant",
			content: [
				{type: "thinking", thinking: "not for the window"},
				{type: "text", text: "hi b"},
			],
			model: {provider: "faux", id: "faux-1"},
			timestamp: 11,
			status: "streaming",
		};
		const folded = eventsOf(
			projectionOf(restored, [itemOf(user), ...itemsOf(streaming)]),
			restored,
		);
		expect(folded.events).toEqual([
			{kind: "item", item: itemOf(assistant("hi back", 0.42))},
			{
				kind: "usage",
				turn: "item-1",
				model: "faux/faux-1",
				inputTokens: 11,
				outputTokens: 22,
				cost: 0.42,
			},
			{kind: "phase", phase: "ready"},
		]);
	});

	/**
	 * A boundary this snapshot does not carry — a compaction renumbered the transcript out from
	 * under the caller — seeds nothing and replays. A visibly wrong transcript is recoverable; a
	 * silently missing reply is not.
	 */
	it("replays rather than guesses when the boundary is not in the snapshot", () => {
		const restored = snapshot([user, assistant("hi back", 0.42)], "idle", 7);
		const folded = eventsOf(
			projectionOf(restored, [
				{kind: "assistant", id: itemId("item-gone"), timestamp: 9, text: "gone"},
			]),
			restored,
		);
		expect(folded.events.filter((event) => event.kind === "item")).toHaveLength(3);
	});

	/**
	 * The phase is the one thing the seed leaves out: `start` emits its own `ready` after the
	 * attach, so a session still working when it was reattached has to restate `prompting`.
	 */
	it("restates the phase of a session that was still working when it was reattached", () => {
		const working = snapshot([user], "turn", 7);
		expect(eventsOf(projectionOf(working, heldThrough(working, "item-0")), working).events).toEqual(
			[{kind: "phase", phase: "prompting"}],
		);
	});

	/**
	 * A turn mid-stream is still one whole message: the wire's own `assistant_delta` never reaches
	 * this fold — `PiClientService.snapshots` keeps only `session_snapshot` — so a growing reply
	 * arrives as successive whole revisions. Its reasoning must therefore supersede itself under one
	 * id, not stack a second row per revision.
	 */
	it("supersedes a streaming turn's reasoning row instead of stacking one per revision", () => {
		const streaming: PiTranscriptItem = {
			id: "item-1",
			role: "assistant",
			content: [
				{type: "thinking", thinking: "half a th"},
				{type: "text", text: "hi"},
			],
			model: {provider: "faux", id: "faux-1"},
			timestamp: 11,
			status: "streaming",
		};
		const first = eventsOf(emptyProjection, snapshot([user, streaming], "turn"));
		const second = eventsOf(first.next, snapshot([user, assistant("hi back")], "idle", 2));
		expect(first.events.flatMap((event) => (event.kind === "item" ? [event.item.id] : []))).toEqual(
			["item-0", "item-1:thinking", "item-1"],
		);
		expect(
			second.events.flatMap((event) => (event.kind === "item" ? [event.item.id] : [])),
		).toEqual(["item-1:thinking", "item-1"]);
		expect(second.next.items.size).toBe(3);
	});

	it("re-sends a tool row under the same id when its result lands", () => {
		const first = eventsOf(emptyProjection, snapshot([user, runningTool], "turn"));
		const second = eventsOf(first.next, snapshot([user, settledTool], "idle", 2));
		expect(second.events).toEqual([
			{kind: "item", item: itemOf(settledTool)},
			{kind: "phase", phase: "ready"},
		]);
	});
});

/**
 * What the streaming marker buys once it reaches the core: the in-flight row supersedes itself
 * under one id, and the tail holding it is a state `checkpointWorthy` refuses to write (#8170).
 * `holdsPartialItem` is the generic rule and needs no Pi arm — this pins that Pi now trips it.
 */
describe("a Pi reply arriving as it is written", () => {
	const machine = aiAgentSessionMachine({cwd: "/workspace"});

	const fold = (
		state: AiAgentSessionState,
		events: ReadonlyArray<AgentEvent>,
	): AiAgentSessionState =>
		events.reduce(
			(carried, event) =>
				applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(
					machine,
					carried,
					{type: "event", sessionId: "session-7602", event},
				)[0],
			state,
		);

	const opened: AiAgentSessionState = {
		...initialState("/workspace"),
		phase: "ready",
		sessionId: "session-7602",
	};

	const rows = (folded: ReturnType<typeof eventsOf>) =>
		folded.events.flatMap((event) => (event.kind === "item" ? [event.item] : []));

	it("supersedes the partial row rather than appending the settled one beside it", () => {
		const first = eventsOf(emptyProjection, snapshot([user, streamingAssistant("hi")], "turn"));
		const second = eventsOf(first.next, snapshot([user, settledAssistant("hi back")], "idle", 2));
		expect(rows(first).map((item) => item.id)).toEqual(["item-0", "item-1"]);
		expect(rows(first).at(-1)).toMatchObject({partial: true});
		expect(rows(second).map((item) => item.id)).toEqual(["item-1"]);
		expect(rows(second).some((item) => "partial" in item)).toBe(false);
		expect(
			fold(fold(opened, first.events), second.events).transcript.items.map((i) => i.id),
		).toEqual(["item-0", "item-1"]);
	});

	it("keeps the tail out of the store while the reply grows, and lets it in once it settles", () => {
		const first = eventsOf(emptyProjection, snapshot([user, streamingAssistant("hi")], "turn"));
		const second = eventsOf(first.next, snapshot([user, settledAssistant("hi back")], "idle", 2));
		const growing = fold(opened, first.events);
		expect(holdsPartialItem(growing)).toBe(true);
		expect(holdsPartialItem(fold(growing, second.events))).toBe(false);
	});
});

/**
 * Pi's half of #8007: asking for an abort leaves the session busy, and the confirming event is this
 * fan's own — the next revision reports the session back at `idle`, which `phaseOf` reads as `ready`.
 * Folded through the real core, because a mapping that reads right over a core still stuck at
 * `prompting` would have proved nothing.
 */
describe("an interruption over the Pi event path", () => {
	const machine = aiAgentSessionMachine({cwd: "/workspace"});
	const SENT_AT = 1_700_000_000_000;

	const apply = (
		state: AiAgentSessionState,
		msg: AiAgentSessionMsg,
	): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
		applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(
			machine,
			state,
			msg,
		);

	const fold = (
		state: AiAgentSessionState,
		events: ReadonlyArray<AgentEvent>,
	): AiAgentSessionState =>
		events.reduce(
			(carried, event) => apply(carried, {type: "event", sessionId: "session-7602", event})[0],
			state,
		);

	/** A session mid-turn with the abort already asked for. */
	const asked = (): {
		readonly state: AiAgentSessionState;
		readonly running: ReturnType<typeof eventsOf>["next"];
	} => {
		const running = eventsOf(emptyProjection, snapshot([user], "turn"));
		const opened: AiAgentSessionState = {
			...initialState("/workspace"),
			phase: "ready",
			sessionId: "session-7602",
		};
		const [prompting] = apply(opened, {
			type: "prompt",
			text: "say hello",
			key: "k1",
			timestamp: SENT_AT,
		});
		const [state] = apply(fold(prompting, running.events), {type: "interrupt", at: SENT_AT + 1});
		return {state, running: running.next};
	};

	it("stays busy with the request outstanding while Pi still reports the turn", () => {
		const {state, running} = asked();
		const next = eventsOf(running, snapshot([user, assistant("still going")], "turn", 2));
		const after = fold(state, next.events);
		expect(after.phase).toBe("prompting");
		expect(after.interruption).toEqual({requestedAt: SENT_AT + 1});
	});

	it("comes back to ready on the revision that reports the session idle", () => {
		const {state, running} = asked();
		const settled = eventsOf(running, snapshot([user, assistant("hi back")], "idle", 2));
		expect(settled.events).toContainEqual({kind: "phase", phase: "ready"});
		const after = fold(state, settled.events);
		expect(after.phase).toBe("ready");
		expect(after.interruption).toBeNull();
	});
});
