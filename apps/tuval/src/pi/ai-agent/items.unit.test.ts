/**
 * The revision fold, over hand-built wire values rather than a live session: this is the one place
 * a Pi snapshot becomes something the window can render, so every case it has to get right is
 * cheaper to pin here than to provoke out of a model.
 */

import {applyCellChecked} from "@demlik/tea";
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
import type {
	TranscriptItem as PiTranscriptItem,
	SessionDelta,
	SessionSnapshot,
} from "../wire/index.ts";
import {
	childEventsOf,
	deltaEventsOf,
	emptyProjection,
	eventsOf,
	itemId,
	itemOf,
	itemsOf,
	phaseOf,
	projectionOf,
} from "./items.ts";

/**
 * The seed a resume opens on, with the "nothing to seed from" answer read as the empty projection
 * — which is what `PiAiAgent` does with it before painting the history instead.
 */
const seedOf = (
	source: SessionSnapshot,
	held: ReadonlyArray<TranscriptItem>,
): ReturnType<typeof eventsOf>["next"] => projectionOf(source, held) ?? emptyProjection;

/** The same snapshot one revision on, which is what the push after a seed actually carries. */
const bumped = (source: SessionSnapshot): SessionSnapshot => ({
	...source,
	revision: source.revision + 1,
});

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
	 * The schedule from PR #8544's report: a turn's push wins the race against its own answer, the
	 * operator's next send walks the projection back to `prompting`, and the answer lands carrying
	 * an `idle` the projection has already passed. Folded, it emits a second `ready` under a live
	 * turn and the core admits the next send mid-turn (#8214). The revision is what refuses it, so
	 * arrival order is no longer the variable.
	 */
	it("drops an update at the revision it has already folded", () => {
		const turn = snapshot([user, assistant("hi back", 0.42)], "idle", 2);
		const folded = eventsOf(emptyProjection, turn);
		const sent = {...folded.next, phase: "prompting" as const};

		const late = eventsOf(sent, turn);
		expect(late.events).toEqual([]);
		expect(late.next).toBe(sent);
	});

	it("drops an update below the revision it has already folded", () => {
		const folded = eventsOf(emptyProjection, snapshot([user, assistant("hi back")], "idle", 5));
		const behind = eventsOf(folded.next, snapshot([user], "turn", 4));
		expect(behind.events).toEqual([]);
		expect(behind.next).toBe(folded.next);
	});

	/**
	 * A resume opens a fresh fold over a transcript the operator is already reading, so the seed
	 * off the attach lease's snapshot has to make a whole-value push a no-op: no
	 * `item`, so nothing is appended after the operator's own turn and pushed out of the window's
	 * 40-item cut, and no `usage`, so the session's totals are not re-added (#8369).
	 */
	it("emits no item and no usage when a resume's seed already holds the whole transcript", () => {
		const restored = snapshot([user, assistant("hi back", 0.42)], "idle", 7);
		const folded = eventsOf(seedOf(restored, heldThrough(restored, "item-1")), bumped(restored));
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
			seedOf(restored, heldThrough(restored, "item-1")),
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
		const folded = eventsOf(seedOf(restored, heldThrough(restored, user.id)), bumped(restored));
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
			seedOf(restored, heldThrough(restored, "item-1:thinking")),
			bumped(restored),
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
	 * (`../wire/transcript.ts`), so a reply the drop caught
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
			seedOf(restored, [itemOf(user), ...itemsOf(streaming)]),
			bumped(restored),
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
			seedOf(restored, [{kind: "assistant", id: itemId("item-gone"), timestamp: 9, text: "gone"}]),
			bumped(restored),
		);
		expect(folded.events.filter((event) => event.kind === "item")).toHaveLength(3);
	});

	/**
	 * The phase is the one thing the seed leaves out: `start` emits its own `ready` after the
	 * attach, so a session still working when it was reattached has to restate `prompting`.
	 */
	it("restates the phase of a session that was still working when it was reattached", () => {
		const working = snapshot([user], "turn", 7);
		expect(
			eventsOf(seedOf(working, heldThrough(working, "item-0")), bumped(working)).events,
		).toEqual([{kind: "phase", phase: "prompting"}]);
	});

	/**
	 * A turn mid-stream is still one whole message. Tuval's wire carries no per-token content patch:
	 * a `SessionDelta` names the whole item that moved (`../wire/delta.ts`), so a growing reply
	 * arrives as successive whole copies of one item. Its reasoning must therefore supersede itself
	 * under one id, not stack a second row per revision.
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
 * The same fold over a delta rather than a whole value. A streamed turn signals per token, so this
 * is the arm a live turn actually rides: the walk is over what the delta names, and everything it
 * does not name is carried forward untouched.
 */
describe("one delta folded into events", () => {
	const delta = (
		items: ReadonlyArray<PiTranscriptItem>,
		revision: number,
		phase?: SessionSnapshot["phase"],
	): SessionDelta => ({
		id: "session-7602",
		revision,
		updatedAt: revision * 100,
		...(phase === undefined ? {} : {phase}),
		...(items.length === 0 ? {} : {items: [...items]}),
	});

	it("emits the one item a token changed and nothing else", () => {
		const opened = eventsOf(emptyProjection, snapshot([user, streamingAssistant("hi")], "turn"));
		const folded = deltaEventsOf(opened.next, delta([streamingAssistant("hi t")], 2));
		expect(folded.events).toEqual([{kind: "item", item: itemOf(streamingAssistant("hi t"))}]);
	});

	it("carries the rest of the transcript forward rather than re-emitting it", () => {
		const opened = eventsOf(emptyProjection, snapshot([user, streamingAssistant("hi")], "turn"));
		const folded = deltaEventsOf(opened.next, delta([streamingAssistant("hi t")], 2));
		const again = deltaEventsOf(folded.next, delta([streamingAssistant("hi t")], 3));
		expect(again.events).toEqual([]);
		expect(folded.next.items.get("item-0")).toBe(opened.next.items.get("item-0"));
	});

	it("emits a settled turn's cost with the reply it annotates, in that order", () => {
		const opened = eventsOf(emptyProjection, snapshot([user, streamingAssistant("hi")], "turn"));
		const folded = deltaEventsOf(opened.next, delta([assistant("hi back", 0.42)], 2, "idle"));
		expect(folded.events).toEqual([
			{kind: "item", item: itemsOf(assistant("hi back", 0.42))[0]},
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

	it("leaves the phase line where it stands when the delta does not name one", () => {
		const opened = eventsOf(emptyProjection, snapshot([user], "turn"));
		const folded = deltaEventsOf(opened.next, delta([streamingAssistant("hi")], 2));
		expect(folded.events.some((event) => event.kind === "phase")).toBe(false);
		expect(folded.next.phase).toBe("prompting");
	});

	it("drops a delta at or below the revision it has already folded", () => {
		const opened = eventsOf(emptyProjection, snapshot([user], "turn", 5));
		const late = deltaEventsOf(opened.next, delta([streamingAssistant("hi")], 5, "idle"));
		expect(late.events).toEqual([]);
		expect(late.next).toBe(opened.next);
	});
});

/**
 * A `pi-subagents` worker over the same delta stream: the call that starts it and the result that
 * ends it are two items of the ordinary transcript, so the running list fills from the wire the
 * whole session already rides (#8555).
 */
describe("a subagent's start and end over the delta stream", () => {
	const delta = (items: ReadonlyArray<PiTranscriptItem>, revision: number): SessionDelta => ({
		id: "session-8555",
		revision,
		updatedAt: revision * 100,
		items: [...items],
	});

	const input = {agent: "reviewer", task: "read it"};

	const spawning: PiTranscriptItem = {
		id: "item-1",
		role: "assistant",
		content: [{type: "toolCall", toolCallId: "call-9", toolName: "subagent", input}],
		model: {provider: "faux", id: "faux-1"},
		timestamp: 11,
		status: "complete",
		stopReason: "toolUse",
	};

	const finished: PiTranscriptItem = {
		id: "item-2",
		role: "tool",
		toolCallId: "call-9",
		toolName: "subagent",
		input,
		content: [{type: "text", text: "spawning reviewer\ndone: 3 findings"}],
		timestamp: 12,
		status: "complete",
		isError: false,
	};

	const opened = () => eventsOf(emptyProjection, snapshot([user], "turn"));

	it("starts one running slot off the call and finishes it off the result", () => {
		const start = deltaEventsOf(opened().next, delta([spawning], 2));
		expect(start.events).toEqual([
			{
				kind: "subagent",
				slot: {
					id: "call-9",
					type: "reviewer",
					lastLine: "",
					startedAt: 11,
					tokens: 0,
					items: [],
					status: "running",
				},
			},
		]);

		const end = deltaEventsOf(start.next, delta([finished], 3));
		expect(end.events).toEqual([
			{kind: "item", item: itemOf(finished)},
			{
				kind: "subagent",
				slot: {
					id: "call-9",
					type: "reviewer",
					lastLine: "done: 3 findings",
					startedAt: 12,
					tokens: 0,
					items: [],
					status: "finished",
				},
			},
		]);
	});

	// The call is still in the transcript after the result lands, so a later delta naming that turn
	// again — a settling usage, a reattach — must not push the worker back to running.
	it("never puts a finished worker back to running", () => {
		const start = deltaEventsOf(opened().next, delta([spawning], 2));
		const end = deltaEventsOf(start.next, delta([finished], 3));
		expect(deltaEventsOf(end.next, delta([spawning], 4)).events).toEqual([]);
	});

	it("leaves an ordinary tool call out of the running list", () => {
		const folded = deltaEventsOf(opened().next, delta([settledTool], 2));
		expect(folded.events.some((event) => event.kind === "subagent")).toBe(false);
	});

	it("labels a spawn that names no agent by the tool that made it", () => {
		const script: PiTranscriptItem = {...finished, input: {workflowScript: "runs.run('a', {})"}};
		const folded = deltaEventsOf(opened().next, delta([script], 2));
		const slots = folded.events.filter((event) => event.kind === "subagent");
		expect(slots).toHaveLength(1);
		expect(slots[0]?.slot.type).toBe("subagent");
	});

	// `subagent` is one multiplexed tool: with an `action` it manages rather than spawns, and the
	// `agent` beside one names that action's target (`pi-subagents` `src/extension/schemas.ts:283-287`,
	// `src/runs/foreground/subagent-executor.ts:5976`). A row for one is a worker that never ran.
	it.each([
		["list", {action: "list"}],
		["status against an agent", {action: "status", agent: "reviewer"}],
		["stop", {action: "stop", id: "run-3"}],
		["schedule.create", {action: "schedule.create", agent: "worker", name: "nightly"}],
		["mission.close", {action: "mission.close", id: "m-1"}],
	])("draws no row for a management call: %s", (_case, managed) => {
		const call: PiTranscriptItem = {
			...spawning,
			content: [{type: "toolCall", toolCallId: "call-9", toolName: "subagent", input: managed}],
		};
		const started = deltaEventsOf(opened().next, delta([call], 2));
		const ended = deltaEventsOf(started.next, delta([{...finished, input: managed}], 3));
		expect(started.events.some((event) => event.kind === "subagent")).toBe(false);
		expect(ended.events.some((event) => event.kind === "subagent")).toBe(false);
	});

	// `bg_wait` waits on runs that are already slots (`src/runs/background/wait-tool.ts:36`), so a
	// row for one duplicates a worker the list already draws.
	it("draws no row for a bg_wait", () => {
		const wait: PiTranscriptItem = {...finished, toolName: "bg_wait", input: {all: true}};
		const folded = deltaEventsOf(opened().next, delta([wait], 2));
		expect(folded.events.some((event) => event.kind === "subagent")).toBe(false);
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

/**
 * The empty `agent` row of #8216: a turn that only called a tool has no text, and a label over
 * nothing reads as a reply that was dropped or is still loading. The rows the turn really produced
 * — its reasoning, its calls, its cost — are the ones that must survive the suppression.
 */
describe("a turn with nothing to read", () => {
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

	const call = {
		type: "toolCall" as const,
		toolCallId: "call-1",
		toolName: "read_file",
		input: {path: "README.md"},
	};

	/** The reported shape: the model answered by calling a tool and wrote no prose at all. */
	const toolOnly: PiTranscriptItem = {
		id: "item-1",
		role: "assistant",
		content: [call],
		model: {provider: "faux", id: "faux-1"},
		usage: usage(0.42),
		timestamp: 11,
		status: "complete",
		stopReason: "toolUse",
	};

	const reasonedToolOnly: PiTranscriptItem = {
		...toolOnly,
		content: [{type: "thinking", thinking: "read it first"}, call],
	};

	it("draws the tool it called and no empty reply beside it", () => {
		expect(itemsOf(toolOnly)).toEqual([]);
		const folded = eventsOf(emptyProjection, snapshot([user, toolOnly, settledTool], "idle"));
		const items = folded.events.flatMap((event) => (event.kind === "item" ? [event.item] : []));
		expect(items.map((item) => item.kind)).toEqual(["user", "tool"]);
	});

	it("keeps the reasoning, the tool row, the cost and the phase the turn ended on", () => {
		const folded = eventsOf(
			emptyProjection,
			snapshot([user, reasonedToolOnly, settledTool], "idle"),
		);
		expect(folded.events).toEqual([
			{kind: "item", item: {kind: "user", id: "item-0", timestamp: 10, text: "say hello"}},
			{
				kind: "item",
				item: {kind: "thinking", id: "item-1:thinking", timestamp: 11, text: "read it first"},
			},
			{
				kind: "item",
				item: {
					kind: "tool",
					id: "call-1",
					timestamp: 12,
					name: "read_file",
					input: {path: "README.md"},
					result: {text: "the file", omitted: {bytes: 0}},
					status: "ok",
				},
			},
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

	it("renders one reply once when an empty partial grows into a settled one", () => {
		const first = eventsOf(emptyProjection, snapshot([user, streamingAssistant("")], "turn"));
		const second = eventsOf(first.next, snapshot([user, streamingAssistant("hi")], "turn", 2));
		const third = eventsOf(second.next, snapshot([user, settledAssistant("hi back")], "idle", 3));
		expect(
			first.events.some((event) => event.kind === "item" && event.item.kind === "assistant"),
		).toBe(false);
		const settled = fold(fold(fold(opened, first.events), second.events), third.events);
		expect(settled.transcript.items.map((item) => [item.id, item.kind])).toEqual([
			["item-0", "user"],
			["item-1", "assistant"],
		]);
		expect(settled.transcript.items.at(-1)).toEqual({
			kind: "assistant",
			id: "item-1",
			timestamp: 11,
			text: "hi back",
		});
	});

	it("leaves no empty reply behind when the turn settles textless", () => {
		const first = eventsOf(emptyProjection, snapshot([user, streamingAssistant("")], "turn"));
		const second = eventsOf(first.next, snapshot([user, toolOnly, settledTool], "idle", 2));
		const settled = fold(fold(opened, first.events), second.events);
		expect(settled.transcript.items.map((item) => item.kind)).toEqual(["user", "tool"]);
		expect(holdsPartialItem(settled)).toBe(false);
	});

	it("still draws an interrupted reply that carries no text", () => {
		const aborted: PiTranscriptItem = {
			...toolOnly,
			content: [],
			status: "aborted",
			stopReason: "aborted",
		};
		expect(itemsOf(aborted)).toEqual([
			{kind: "assistant", id: "item-1", timestamp: 11, text: "", interrupted: true},
		]);
	});

	it("keeps ordinary replies and user turns, and explains an empty failed turn", () => {
		expect(itemsOf(settledAssistant("hi back"))).toEqual([
			{kind: "assistant", id: "item-1", timestamp: 11, text: "hi back"},
		]);
		expect(itemsOf({...user, content: []})).toEqual([
			{kind: "user", id: "item-0", timestamp: 10, text: ""},
		]);
		const failed: PiTranscriptItem = {
			...toolOnly,
			content: [],
			status: "error",
			stopReason: "error",
		};
		expect(itemsOf(failed)).toEqual([
			{
				kind: "system",
				id: "item-1:failure",
				timestamp: 11,
				text: "Turn failed: the provider could not complete the response. Check your provider account or try again later.",
			},
		]);
	});
});

/**
 * The worker's own rows, off the JSONL artifact it appends to while it runs. The spawn is a
 * detached child process (#8555), so nothing it writes is a session event: the wire states the run
 * once, on the running tool row's `details`, and everything after that arrives out of band.
 */
describe("a running subagent filled from its own transcript artifact", () => {
	const input = {agent: "reviewer", task: "read it"};

	const running: PiTranscriptItem = {
		id: "item-2",
		role: "tool",
		toolCallId: "call-9",
		toolName: "subagent",
		input,
		content: [],
		details: {runId: "run-1"},
		timestamp: 11,
		status: "running",
		isError: false,
	};

	const child = {
		items: [
			{kind: "assistant" as const, id: itemId("child-0"), timestamp: 12, text: "reading src/a.ts"},
		],
		lastLine: "reading src/a.ts",
		tokens: 42,
	};

	const childRow = {
		kind: "assistant",
		id: "call-9:run-0-child-0",
		parentId: "call-9",
		timestamp: 12,
		text: "reading src/a.ts",
	};

	const opened = eventsOf(emptyProjection, snapshot([running], "turn"));

	const tailed = () => childEventsOf(opened.next, new Map([["run-1", child]]));

	it("tracks the run the running row names", () => {
		expect([...opened.next.spawns.values()]).toEqual([
			{
				id: "call-9",
				toolCallId: "call-9",
				runId: "run-1",
				resolved: null,
				agent: "reviewer",
				startedAt: 11,
			},
		]);
	});

	it("fills the slot's items, last line and tokens off the artifact", () => {
		expect(tailed().events).toEqual([
			{
				kind: "subagent",
				slot: {
					id: "call-9",
					type: "reviewer",
					lastLine: "reading src/a.ts",
					startedAt: 11,
					tokens: 42,
					items: [childRow],
					status: "running",
				},
			},
		]);
	});

	it("emits nothing while the artifact has not moved", () => {
		expect(childEventsOf(tailed().next, new Map([["run-1", child]])).events).toEqual([]);
	});

	// A wire push landing between two reads must restate what the tail already showed, or every
	// silent revision blanks the rows the operator is reading.
	it("does not blank the slot when a later push refolds the same row", () => {
		const pushed = deltaEventsOf(
			tailed().next,
			{id: "session-8663", revision: 2, updatedAt: 200, items: [running]},
			new Map([["run-1", child]]),
		);
		expect(pushed.events).toEqual([]);
	});

	it("stops tracking the run once the call answers, keeping the rows it read", () => {
		const answered: PiTranscriptItem = {
			...running,
			content: [{type: "text", text: "done: 3 findings"}],
			timestamp: 13,
			status: "complete",
			isError: false,
		};
		const ended = deltaEventsOf(
			opened.next,
			{id: "session-8663", revision: 2, updatedAt: 200, items: [answered]},
			new Map([["run-1", child]]),
		);
		expect(ended.next.spawns.size).toBe(0);
		expect(ended.events).toContainEqual({
			kind: "subagent",
			slot: {
				id: "call-9",
				type: "reviewer",
				lastLine: "reading src/a.ts",
				startedAt: 13,
				tokens: 42,
				items: [childRow],
				status: "finished",
			},
		});
	});

	// The keying is the spawning call's id and nothing else, so a parallel spawn stays exactly the
	// 1:N it already is.
	it("keys the slot on the spawning call, not on the run", () => {
		expect(tailed().events.map((event) => event.kind === "subagent" && event.slot.id)).toEqual([
			"call-9",
		]);
	});

	it("leaves the slot empty when the artifact is not readable yet", () => {
		expect(childEventsOf(opened.next, new Map()).events).toEqual([]);
	});
});

/**
 * A detached spawn (`async: true`, which every `workflowScript` run is) emits no
 * `tool_execution_update`, so its row carries no run id and its workers write under ids of their
 * own. The tool-call index is the only address left, and the tail hands its answer to the fold
 * (#8679).
 */
describe("a detached subagent filled through the tool-call index", () => {
	const running: PiTranscriptItem = {
		id: "item-3",
		role: "tool",
		toolCallId: "call-async",
		toolName: "subagent",
		input: {async: true, context: "fresh", workflowScript: "runs.run('lane')"},
		content: [],
		timestamp: 21,
		status: "running",
		isError: false,
	};

	const child = {
		items: [
			{kind: "assistant" as const, id: itemId("child-0"), timestamp: 22, text: "cutting the lane"},
		],
		lastLine: "cutting the lane",
		tokens: 17,
	};

	const opened = eventsOf(emptyProjection, snapshot([running], "turn"));
	const resolved = new Map([["call-async", {runIds: ["worker-1"], agent: "builder"}]]);
	const tailed = () => childEventsOf(opened.next, new Map([["worker-1", child]]), resolved);

	it("tracks the call with no workers until the index answers", () => {
		expect([...opened.next.spawns.values()]).toEqual([
			{
				id: "call-async",
				toolCallId: "call-async",
				runId: null,
				resolved: null,
				agent: null,
				startedAt: 21,
			},
		]);
	});

	it("draws an empty running slot while nothing has resolved", () => {
		expect(opened.events).toContainEqual({
			kind: "subagent",
			slot: {
				id: "call-async",
				type: "subagent",
				lastLine: "",
				startedAt: 21,
				tokens: 0,
				items: [],
				status: "running",
			},
		});
	});

	it("fills the slot off the resolved worker's artifact and names it after the step", () => {
		expect(tailed().events).toEqual([
			{
				kind: "subagent",
				slot: {
					id: "call-async",
					type: "builder",
					lastLine: "cutting the lane",
					startedAt: 21,
					tokens: 17,
					items: [
						{
							kind: "assistant",
							id: "call-async:run-0-child-0",
							parentId: "call-async",
							timestamp: 22,
							text: "cutting the lane",
						},
					],
					status: "running",
				},
			},
		]);
	});

	// The resolution is the projection's now, so a wire push landing between two reads restates the
	// filled slot rather than blanking the rows the operator is looking at.
	it("keeps the resolution when a later push refolds the same row", () => {
		const pushed = deltaEventsOf(
			tailed().next,
			{id: "session-8679", revision: 2, updatedAt: 200, items: [running]},
			new Map([["worker-1", child]]),
		);
		expect(pushed.events).toEqual([]);
		expect([...pushed.next.spawns.values()]).toEqual([
			{
				id: "call-async",
				toolCallId: "call-async",
				runId: null,
				resolved: {runIds: ["worker-1"], agent: "builder"},
				agent: null,
				startedAt: 21,
			},
		]);
	});

	it("leaves the slot alone when the index resolves nothing", () => {
		expect(childEventsOf(opened.next, new Map(), new Map()).events).toEqual([]);
	});

	// A `workflowScript` declares its steps up front and each gains its `runId` at launch, so a run
	// resolved once and never re-read would sit on the first worker's last line for the whole lane.
	it("picks up a step that gains its run id after the first resolution", () => {
		const first = childEventsOf(opened.next, new Map([["worker-1", child]]), resolved);
		const reviewing = {
			items: [
				{
					kind: "assistant" as const,
					id: itemId("child-0"),
					timestamp: 24,
					text: "reading the diff",
				},
			],
			lastLine: "reading the diff",
			tokens: 9,
		};
		const second = childEventsOf(
			first.next,
			new Map([
				["worker-1", child],
				["worker-2", reviewing],
			]),
			new Map([["call-async", {runIds: ["worker-1", "worker-2"], agent: "builder, reviewer"}]]),
		);
		expect(second.events).toEqual([
			{
				kind: "subagent",
				slot: {
					id: "call-async",
					type: "builder, reviewer",
					lastLine: "reading the diff",
					startedAt: 21,
					tokens: 26,
					items: [
						{
							kind: "assistant",
							id: "call-async:run-0-child-0",
							parentId: "call-async",
							timestamp: 22,
							text: "cutting the lane",
						},
						{
							kind: "assistant",
							id: "call-async:run-1-child-0",
							parentId: "call-async",
							timestamp: 24,
							text: "reading the diff",
						},
					],
					status: "running",
				},
			},
		]);
	});

	// A tick that reads nothing must not undo the last one that read something.
	it("keeps the workers it resolved when a later read answers nothing", () => {
		const first = childEventsOf(opened.next, new Map([["worker-1", child]]), resolved);
		const blank = childEventsOf(first.next, new Map([["worker-1", child]]), new Map());
		expect(blank.events).toEqual([]);
		expect([...blank.next.spawns.values()][0]?.resolved).toEqual({
			runIds: ["worker-1"],
			agent: "builder",
		});
	});

	it("keeps the agent the call named over the one its steps report", () => {
		const named = eventsOf(
			emptyProjection,
			snapshot([{...running, input: {async: true, agent: "reviewer"}}], "turn"),
		);
		expect(
			childEventsOf(named.next, new Map([["worker-1", child]]), resolved).events.map(
				(event) => event.kind === "subagent" && event.slot.type,
			),
		).toEqual(["reviewer"]);
	});
});
