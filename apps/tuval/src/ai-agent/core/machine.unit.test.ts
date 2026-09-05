/**
 * The transition table, one cell at a time, plus the Cmd each Msg is answerable for.
 *
 * Every case runs through Demlik's own `applyCellChecked` rather than reaching into `update`, so
 * a Msg the table stops covering reds here instead of silently doing nothing.
 */

import {applyCellChecked} from "@demlik/tea";
import {describe, expect, it} from "vitest";
import {assistantItem, toolItem, userItem} from "../../ai-agent-fixtures/transcripts.ts";
import type {AgentEvent} from "../events.ts";
import {Mode, type ModelRef, type PermissionRequest} from "../ports/index.ts";
import {aiAgentSessionMachine} from "./machine.ts";
import type {AiAgentSessionCmd, AiAgentSessionMsg} from "./messages.ts";
import {type AiAgentSessionState, initialState} from "./state.ts";

const machine = aiAgentSessionMachine({cwd: "/repo"});

const apply = (
	state: AiAgentSessionState,
	msg: AiAgentSessionMsg,
): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
	applyCellChecked<AiAgentSessionState, AiAgentSessionMsg, AiAgentSessionCmd>(machine, state, msg);

const opus: ModelRef = {provider: "anthropic", id: "claude-opus-5", name: "Opus 5"};
const sonnet: ModelRef = {provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5"};

const card: PermissionRequest = {
	title: "Write README.md",
	displayName: "write_file",
	description: "Create a file",
	input: {path: "README.md"},
	offersAlways: false,
};

const started = (over: Partial<AiAgentSessionState> = {}): AiAgentSessionState => ({
	...initialState("/repo"),
	phase: "ready",
	sessionId: "session-1",
	...over,
});

describe("init", () => {
	it("opens a fresh session idle in the configured directory, and asks to boot it", () => {
		const [state, cmds] = machine.init(null, {});
		expect(state).toEqual(initialState("/repo"));
		// Spawning the program is the whole act: nothing else in the tree dispatches `start` (#7925).
		expect(cmds).toEqual([{type: "aiAgent.boot", cwd: "/repo"}]);
	});

	it("restores a loaded state and emits no Cmd, as Demlik's rehydrate contract demands", () => {
		const loaded = started({
			phase: "prompting",
			transcript: {
				items: [assistantItem("a1"), userItem("u2")],
				omitted: initialState("/x").transcript.omitted,
			},
		});
		const [state, cmds] = machine.init(loaded, {});
		// `idle`, not `reconnecting`: a booted process holds no transport, and `idle` is the phase a
		// `reconnect` Msg is admissible from (`../restore/checkpoint.ts`).
		expect(state.phase).toBe("idle");
		expect(state.interrupted).toBe("a1");
		expect(cmds).toEqual([]);
	});
});

describe("start", () => {
	it("opens a session and asks the layer to start it", () => {
		const [state, cmds] = apply(initialState("/repo"), {
			type: "start",
			cwd: "/other",
			resume: null,
		});
		expect(state.phase).toBe("starting");
		expect(state.cwd).toBe("/other");
		expect(cmds).toEqual([{type: "aiAgent.start", cwd: "/other", resume: null}]);
	});

	it("carries the resume id for a session the backend already holds", () => {
		const [, cmds] = apply(initialState("/repo"), {
			type: "start",
			cwd: "/repo",
			resume: "session-1",
		});
		expect(cmds).toEqual([{type: "aiAgent.start", cwd: "/repo", resume: "session-1"}]);
	});

	it("refuses as data while a session is already live", () => {
		const [state, cmds] = apply(started(), {type: "start", cwd: "/repo", resume: null});
		expect(state.phase).toBe("ready");
		expect(state.failure?.tag).toBe("tuval/ai-agent/StartError");
		expect(cmds).toEqual([]);
	});
});

describe("started", () => {
	it("takes the session id and becomes ready", () => {
		const opening: AiAgentSessionState = {...initialState("/repo"), phase: "starting"};
		const [state, cmds] = apply(opening, {type: "started", sessionId: "session-9"});
		expect(state).toMatchObject({phase: "ready", sessionId: "session-9", failure: null});
		expect(cmds).toEqual([]);
	});

	it("is discarded once the session is gone", () => {
		const gone = started({phase: "gone"});
		expect(apply(gone, {type: "started", sessionId: "session-9"})[0]).toEqual(gone);
	});
});

describe("prompt", () => {
	it("sends the turn and remembers it for the resend", () => {
		const [state, cmds] = apply(started({interrupted: null}), {
			type: "prompt",
			text: "make the README",
			key: "k1",
		});
		expect(state).toMatchObject({phase: "prompting", lastPrompt: "make the README"});
		expect(cmds).toEqual([{type: "aiAgent.prompt", text: "make the README", key: "k1"}]);
	});

	it("is refused as data outside ready, and emits nothing", () => {
		for (const phase of ["idle", "starting", "prompting", "reconnecting", "gone"] as const) {
			const [state, cmds] = apply(started({phase}), {type: "prompt", text: "hi", key: "k"});
			expect(state.failure?.tag).toBe("tuval/ai-agent/PromptError");
			expect(state.phase).toBe(phase);
			expect(cmds).toEqual([]);
		}
	});

	it("clears the interrupted marker, because a resend is a new send", () => {
		const [state] = apply(started({interrupted: assistantItem("a1").id}), {
			type: "prompt",
			text: "again",
			key: "k2",
		});
		expect(state.interrupted).toBeNull();
	});
});

describe("event", () => {
	const itemEvent = (id: string): AgentEvent => ({kind: "item", item: assistantItem(id, "hello")});

	it("appends an item to the tail", () => {
		const [state, cmds] = apply(started(), {
			type: "event",
			sessionId: "session-1",
			event: itemEvent("a1"),
		});
		expect(state.transcript.items.map((item) => item.id)).toEqual(["a1"]);
		expect(cmds).toEqual([]);
	});

	it("supersedes an item that re-arrives under the same id", () => {
		const running = toolItem("t1");
		const [first] = apply(started(), {
			type: "event",
			sessionId: "session-1",
			event: {kind: "item", item: {...running, status: "running"}},
		});
		const [second] = apply(first, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "item", item: {...running, status: "ok"}},
		});
		expect(second.transcript.items).toHaveLength(1);
		expect(second.transcript.items[0]).toMatchObject({id: "t1", status: "ok"});
	});

	it("replaces the mode list", () => {
		const [state] = apply(started(), {
			type: "event",
			sessionId: "session-1",
			event: {kind: "mode", current: Mode.make("plan"), available: [Mode.make("plan")]},
		});
		expect(state.modes).toEqual({current: "plan", available: ["plan"]});
	});

	it("accumulates cost and tokens across usage events", () => {
		const usage = (cost: number): AgentEvent => ({
			kind: "usage",
			model: "claude-opus-5",
			inputTokens: 10,
			outputTokens: 5,
			cost,
		});
		const [once] = apply(started(), {type: "event", sessionId: "session-1", event: usage(0.01)});
		const [twice] = apply(once, {type: "event", sessionId: "session-1", event: usage(0.02)});
		expect(twice.usage).toEqual({
			model: "claude-opus-5",
			inputTokens: 20,
			outputTokens: 10,
			cost: 0.03,
		});
	});

	it("adds a permission card and drops it when the backend settles it itself", () => {
		const [asked] = apply(started(), {
			type: "event",
			sessionId: "session-1",
			event: {kind: "permission", request: "req-1", detail: card},
		});
		expect(asked.permissions).toEqual({"req-1": card});
		const [settled] = apply(asked, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "permission-resolved", request: "req-1", decision: "deny"},
		});
		expect(settled.permissions).toEqual({});
	});

	it("takes a phase the layer reports that the core does not own", () => {
		const [state] = apply(started(), {
			type: "event",
			sessionId: "session-1",
			event: {kind: "phase", phase: "prompting"},
		});
		expect(state.phase).toBe("prompting");
	});

	// Every layer narrates its own open on the same stream (`PiAiAgent.start` emits `starting` then
	// `ready`), and that stream is opened by the `started` the open already answered — so the
	// `starting` a Sub reads first always lands on a session that is already ready (#7925).
	it("ignores an opening phase the layer replays, so a ready session still takes a prompt", () => {
		const [state] = apply(started(), {
			type: "event",
			sessionId: "session-1",
			event: {kind: "phase", phase: "starting"},
		});
		expect(state.phase).toBe("ready");

		const [prompted, cmds] = apply(state, {type: "prompt", text: "hello", key: "k1"});
		expect(prompted.failure).toBeNull();
		expect(cmds).toEqual([{type: "aiAgent.prompt", text: "hello", key: "k1"}]);
	});

	it("ignores a replayed reconnecting phase for the same reason", () => {
		const [state] = apply(started(), {
			type: "event",
			sessionId: "session-1",
			event: {kind: "phase", phase: "reconnecting"},
		});
		expect(state.phase).toBe("ready");
	});

	it("is discarded once the session is gone", () => {
		const gone = started({phase: "gone"});
		const [state, cmds] = apply(gone, {
			type: "event",
			sessionId: "session-1",
			event: itemEvent("a1"),
		});
		expect(state).toEqual(gone);
		expect(cmds).toEqual([]);
	});
});

describe("answer", () => {
	it("removes the card it answers and asks the layer to decide it", () => {
		const pending = started({permissions: {"req-1": card}});
		const [state, cmds] = apply(pending, {
			type: "answer",
			request: "req-1",
			decision: "allow-once",
		});
		expect(state.permissions).toEqual({});
		expect(cmds).toEqual([{type: "aiAgent.answer", request: "req-1", decision: "allow-once"}]);
	});

	it("refuses an id no card is pending under", () => {
		const [state, cmds] = apply(started(), {
			type: "answer",
			request: "ghost",
			decision: "deny",
		});
		expect(state.failure?.tag).toBe("tuval/ai-agent/UnknownRequest");
		expect(cmds).toEqual([]);
	});
});

describe("setMode", () => {
	const offering = started({
		modes: {current: Mode.make("plan"), available: [Mode.make("plan"), Mode.make("build")]},
	});

	it("asks the layer for a mode it offers", () => {
		const [, cmds] = apply(offering, {type: "setMode", mode: Mode.make("build")});
		expect(cmds).toEqual([{type: "aiAgent.setMode", mode: "build"}]);
	});

	it("refuses a mode it does not, including when it offers none", () => {
		const [offered, noCmd] = apply(offering, {type: "setMode", mode: Mode.make("ship")});
		expect(offered.failure?.tag).toBe("tuval/ai-agent/ModeUnsupported");
		expect(noCmd).toEqual([]);
		const [none] = apply(started(), {type: "setMode", mode: Mode.make("plan")});
		expect(none.failure?.tag).toBe("tuval/ai-agent/ModeUnsupported");
	});
});

describe("setModel", () => {
	const offering = started({models: {current: opus, available: [opus, sonnet]}});

	it("asks the layer for a model it offers", () => {
		const [, cmds] = apply(offering, {type: "setModel", model: sonnet});
		expect(cmds).toEqual([{type: "aiAgent.setModel", model: sonnet}]);
	});

	it("matches on provider and id, never on the label a picker sent", () => {
		const [, cmds] = apply(offering, {type: "setModel", model: {...sonnet, name: "whatever"}});
		expect(cmds).toEqual([{type: "aiAgent.setModel", model: {...sonnet, name: "whatever"}}]);
	});

	it("refuses a model it does not offer, including when it offers none", () => {
		const [offered, noCmd] = apply(offering, {
			type: "setModel",
			model: {provider: "openai", id: "gpt", name: "GPT"},
		});
		expect(offered.failure?.tag).toBe("tuval/ai-agent/ModelUnsupported");
		expect(noCmd).toEqual([]);
		const [none] = apply(started(), {type: "setModel", model: opus});
		expect(none.failure?.tag).toBe("tuval/ai-agent/ModelUnsupported");
	});
});

describe("paging older history", () => {
	it("asks the layer for the page", () => {
		const [state, cmds] = apply(started(), {type: "page", before: "i7", limit: 20});
		expect(state).toEqual(started());
		expect(cmds).toEqual([{type: "aiAgent.page", before: "i7", limit: 20}]);
	});

	it("holds the page it got back without folding it into the live tail", () => {
		const page = {items: [userItem("older-0")], hasMore: true};
		const [state, cmds] = apply(started(), {type: "paged", page});
		expect(state.lastPage).toEqual(page);
		expect(state.transcript.items).toEqual([]);
		expect(cmds).toEqual([]);
	});
});

describe("interrupt", () => {
	it("cuts the running turn and marks the assistant item it cut", () => {
		const running = started({
			phase: "prompting",
			transcript: {
				items: [userItem("u0"), assistantItem("a1"), toolItem("t2")],
				omitted: initialState("/x").transcript.omitted,
			},
		});
		const [state, cmds] = apply(running, {type: "interrupt"});
		expect(state.phase).toBe("ready");
		expect(state.interrupted).toBe("a1");
		expect(cmds).toEqual([{type: "aiAgent.interrupt"}]);
	});

	it("does nothing when no turn is running", () => {
		const [state, cmds] = apply(started(), {type: "interrupt"});
		expect(state).toEqual(started());
		expect(cmds).toEqual([]);
	});
});

describe("reconnect", () => {
	it("republishes what it holds, then asks the layer to re-attach the session", () => {
		const [state, cmds] = apply(started({phase: "gone"}), {type: "reconnect"});
		expect(state.phase).toBe("reconnecting");
		expect(cmds).toEqual([
			{type: "aiAgent.republish"},
			{type: "aiAgent.reconnect", cwd: "/repo", sessionId: "session-1"},
		]);
	});

	it("refuses when there is no session to re-attach", () => {
		const [state, cmds] = apply(initialState("/repo"), {type: "reconnect"});
		expect(state.failure?.reason).toBe("session-not-found");
		expect(cmds).toEqual([]);
	});

	// The handler rebuilds the layer, so a second reconnect over an in-flight one would build a
	// second transport into the one process Scope.
	it("refuses a second open while one is in flight", () => {
		for (const phase of ["starting", "reconnecting"] as const) {
			const [state, cmds] = apply(started({phase}), {type: "reconnect"});
			expect(state.failure?.reason).toBe("session-locked");
			expect(cmds).toEqual([]);
		}
	});
});

describe("failed", () => {
	it("records the layer's tag and leaves the phase where the act began", () => {
		const failure = {tag: "tuval/ai-agent/PromptError", reason: "disconnected", detail: "gone"};
		const [fromPrompt] = apply(started({phase: "prompting"}), {type: "failed", failure});
		expect(fromPrompt).toMatchObject({phase: "ready", failure});
		const [fromStart] = apply(started({phase: "starting"}), {type: "failed", failure});
		expect(fromStart.phase).toBe("idle");
		// A reconnect has nowhere before it to go back to, so it lands on `idle` — staying at
		// `reconnecting` is the one phase the reconnect guard itself refuses a retry from.
		const [fromReconnect] = apply(started({phase: "reconnecting"}), {type: "failed", failure});
		expect(fromReconnect.phase).toBe("idle");
	});

	it("ends a resume the backend refused at gone, never anywhere a fresh session can open", () => {
		const failure = {
			tag: "tuval/ai-agent/StartError",
			reason: "session-not-found",
			detail: "the backend holds no session-1",
		};
		const [refused] = apply(started({phase: "reconnecting"}), {type: "failed", failure});
		expect(refused).toMatchObject({phase: "gone", sessionId: "session-1", failure});
		expect(machine.subscriptions?.(refused)).toEqual([]);
	});
});

describe("the Cmd each Msg answers for", () => {
	const cases: ReadonlyArray<
		readonly [AiAgentSessionState, AiAgentSessionMsg, ReadonlyArray<AiAgentSessionCmd["type"]>]
	> = [
		[initialState("/repo"), {type: "start", cwd: "/repo", resume: null}, ["aiAgent.start"]],
		[started({phase: "starting"}), {type: "started", sessionId: "s"}, []],
		[started(), {type: "prompt", text: "hi", key: "k"}, ["aiAgent.prompt"]],
		[
			started(),
			{type: "event", sessionId: "session-1", event: {kind: "phase", phase: "ready"}},
			[],
		],
		[
			started({permissions: {"req-1": card}}),
			{type: "answer", request: "req-1", decision: "deny"},
			["aiAgent.answer"],
		],
		[
			started({modes: {current: null, available: [Mode.make("plan")]}}),
			{type: "setMode", mode: Mode.make("plan")},
			["aiAgent.setMode"],
		],
		[
			started({models: {current: null, available: [opus]}}),
			{type: "setModel", model: opus},
			["aiAgent.setModel"],
		],
		[started(), {type: "page", before: null, limit: 10}, ["aiAgent.page"]],
		[started(), {type: "paged", page: {items: [], hasMore: false}}, []],
		[started({phase: "prompting"}), {type: "interrupt"}, ["aiAgent.interrupt"]],
		[started(), {type: "reconnect"}, ["aiAgent.republish", "aiAgent.reconnect"]],
		[
			started(),
			{type: "failed", failure: {tag: "tuval/ai-agent/PageError", reason: null, detail: "x"}},
			[],
		],
	];

	it("covers every Msg the table declares", () => {
		expect(new Set(cases.map(([, msg]) => msg.type))).toEqual(new Set(Object.keys(machine.update)));
	});

	it("emits exactly that Cmd, and nothing else", () => {
		for (const [state, msg, expected] of cases) {
			const [, cmds] = apply(state, msg);
			expect(cmds.map((cmd) => cmd.type)).toEqual(expected);
		}
	});

	// `init` is the second emitter: the fresh arm's boot Cmd is the one no Msg answers for (#7925).
	it("emits every Cmd the union declares, across the table and the fresh init", () => {
		const emitted = new Set([
			...machine.init(null, {})[1].map((cmd) => cmd.type),
			...cases.flatMap(([state, msg]) => apply(state, msg)[1].map((c) => c.type)),
		]);
		expect(emitted).toEqual(new Set(Object.keys(machine.interpret ?? {})));
	});
});

describe("the events subscription", () => {
	it("is keyed by the session id and the connection, as Sub data", () => {
		expect(machine.subscriptions?.(started())).toEqual([
			{
				id: "aiAgent.events:session-1#0",
				type: "aiAgent.events",
				sessionId: "session-1",
				connection: 0,
			},
		]);
	});

	// The reconnect keeps the session id, so an id made of that alone would read as still running
	// and leave the process listening to the transport the rebuild just closed.
	it("changes id on every started, so a reconnect re-opens the stream", () => {
		const [reopened] = apply(started({phase: "reconnecting"}), {
			type: "started",
			sessionId: "session-1",
		});
		expect(machine.subscriptions?.(reopened)?.[0]?.id).toBe("aiAgent.events:session-1#1");
	});

	it("is absent before a session exists and once it is gone", () => {
		expect(machine.subscriptions?.(initialState("/repo"))).toEqual([]);
		expect(machine.subscriptions?.(started({phase: "gone"}))).toEqual([]);
	});
});

describe("the identity filter", () => {
	it("addresses events to the session they arrived on, and nothing else", () => {
		expect(machine.identity?.ofState(started())).toBe("session-1");
		expect(
			machine.identity?.ofMsg({
				type: "event",
				sessionId: "other",
				event: {kind: "phase", phase: "gone"},
			}),
		).toBe("other");
		expect(machine.identity?.ofMsg({type: "started", sessionId: "session-1"})).toBeUndefined();
	});
});
