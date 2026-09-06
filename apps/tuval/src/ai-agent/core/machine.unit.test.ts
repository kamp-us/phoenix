/**
 * The transition table, one cell at a time, plus the Cmd each Msg is answerable for.
 *
 * Every case runs through Demlik's own `applyCellChecked` rather than reaching into `update`, so
 * a Msg the table stops covering reds here instead of silently doing nothing.
 */

import {applyCellChecked} from "@demlik/tea";
import {describe, expect, it} from "vitest";
import {pendingPermission} from "../../ai-agent-fixtures/permissions.ts";
import {assistantItem, toolItem, userItem} from "../../ai-agent-fixtures/transcripts.ts";
import type {AgentEvent} from "../events.ts";
import {Mode, type ModelRef, type PermissionRequest, type TranscriptItem} from "../ports/index.ts";
import {checkpointUnreadable} from "./failures.ts";
import {promptItemId} from "./fold.ts";
import {aiAgentSessionMachine} from "./machine.ts";
import type {AiAgentSessionCmd, AiAgentSessionMsg} from "./messages.ts";
import {isAiAgentSessionState, loadCheckpoint} from "./snapshot.ts";
import {type AiAgentSessionState, checkpointFields, initialState} from "./state.ts";

const machine = aiAgentSessionMachine({cwd: "/repo"});

/** One fixed send clock, since a prompt now carries the timestamp its recorded turn wears. */
const SENT_AT = 1_700_000_000_000;

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

	// The rehydrate branch is the defaulting parse and nothing else, so what the store read back is
	// checked on the production load path rather than trusted for being typed as the state (#8095).
	it("reads a loaded checkpoint through the parse, not around it", () => {
		const loaded = started();
		expect(machine.init(loaded, {})[0]).toEqual(loadCheckpoint(loaded, "/repo"));
	});
});

/**
 * The load path against checkpoints the running build did not write.
 *
 * These read `loadCheckpoint` rather than `init` because that is the only signature the raw object
 * a store hands back fits: `init` is typed as taking the state, which is the very claim nothing had
 * checked. The wiring — that `init`'s rehydrate branch is this function — is pinned above.
 */
describe("a checkpoint written by an older build", () => {
	const older: Record<string, unknown> = {
		...initialState("/desk"),
		phase: "ready",
		sessionId: "session-9",
		transcript: {items: [userItem("u1")], omitted: initialState("/x").transcript.omitted},
		modes: {current: Mode.make("plan"), available: [Mode.make("plan")]},
		models: {current: opus, available: [opus, sonnet]},
		lastPrompt: "make the README",
	};

	/** The desk's `5c26458b35` shape: the three fields that build's `checkpointFields` never had. */
	const deskShaped = (): Record<string, unknown> => {
		const {commands, permissionsRaised, interruption, ...rest} = older;
		return rest;
	};

	const restoredFrom = (raw: Record<string, unknown>): AiAgentSessionState =>
		loadCheckpoint(raw, "/desk");

	// The session id is asserted beside the three defaults on purpose: `initialState` carries those
	// same three values, so a refusal that wiped the checkpoint would satisfy them on its own.
	it("comes back with each absent field at its empty default", () => {
		const state = restoredFrom(deskShaped());
		expect(state.commands).toEqual([]);
		expect(state.permissionsRaised).toBe(0);
		expect(state.interruption).toBeNull();
		expect(state.sessionId).toBe("session-9");
	});

	it("carries every field it did save through untouched", () => {
		const state = restoredFrom(deskShaped());
		expect(state.transcript).toEqual(older.transcript);
		expect(state.sessionId).toBe("session-9");
		expect(state.cwd).toBe("/desk");
		expect(state.modes).toEqual(older.modes);
		expect(state.models).toEqual(older.models);
		expect(state.lastPrompt).toBe("make the README");
		// The saved `ready` becomes `idle` the way any restore does: the process holds no transport.
		expect(state.phase).toBe("idle");
	});

	it("is a session state once defaulted, so nothing downstream reads an absent field", () => {
		const state = restoredFrom(deskShaped());
		expect(isAiAgentSessionState(state)).toBe(true);
		// The refused state is a session state too, so the predicate alone would pass either way.
		expect(state.sessionId).toBe("session-9");
	});

	// The fill supplies an absent field and never repairs a present one, so the predicate still has
	// something to refuse — a checkpoint that is wrong rather than merely old.
	it("is refused when a field it did save carries the wrong type", () => {
		const state = restoredFrom({...deskShaped(), commands: 3});
		expect(state.failure).toEqual(checkpointUnreadable);
		// `gone`, so the spawner dispatches nothing: an `idle` refusal's fresh `start` would clear
		// the failure before the operator ever read it.
		expect(state.phase).toBe("gone");
		expect(state.transcript.items).toEqual([]);
	});

	it("keeps a refusal the operator can read out of the restored session", () => {
		expect(restoredFrom(deskShaped()).failure).toBeNull();
	});

	// Reds if a field is added to the state with no entry in `initialState` to default it from.
	it("has a default for every field a checkpoint carries", () => {
		const defaulted: ReadonlyArray<string> = Object.keys(initialState("/desk"));
		expect(checkpointFields.filter((field) => !defaulted.includes(field))).toEqual([]);
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
	const prompt = (text: string, key: string): AiAgentSessionMsg => ({
		type: "prompt",
		text,
		key,
		timestamp: SENT_AT,
	});

	it("sends the turn and remembers it for the resend", () => {
		const [state, cmds] = apply(started({interrupted: null}), prompt("make the README", "k1"));
		expect(state).toMatchObject({phase: "prompting", lastPrompt: "make the README"});
		expect(cmds).toEqual([{type: "aiAgent.prompt", text: "make the README", key: "k1"}]);
	});

	it("records the operator's turn on send, before any event is folded", () => {
		const [state] = apply(started(), prompt("make the README", "k1"));
		expect(state.transcript.items).toEqual([
			{
				kind: "user",
				id: promptItemId("k1"),
				timestamp: SENT_AT,
				text: "make the README",
				local: true,
			},
		]);
	});

	it("derives the recorded id from the idempotency key, so a replay lands on one item", () => {
		const [once] = apply(started(), prompt("hi", "k1"));
		const [twice] = apply({...once, phase: "ready"}, prompt("hi", "k1"));
		expect(twice.transcript.items.map((item) => item.id)).toEqual([promptItemId("k1")]);
	});

	it("is refused as data outside ready, and emits nothing", () => {
		for (const phase of ["idle", "starting", "prompting", "reconnecting", "gone"] as const) {
			const [state, cmds] = apply(started({phase}), prompt("hi", "k"));
			expect(state.failure?.tag).toBe("tuval/ai-agent/PromptError");
			expect(state.phase).toBe(phase);
			expect(state.transcript.items).toEqual([]);
			expect(cmds).toEqual([]);
		}
	});

	it("clears the interrupted marker, because a resend is a new send", () => {
		const [state] = apply(started({interrupted: assistantItem("a1").id}), prompt("again", "k2"));
		expect(state.interrupted).toBeNull();
	});
});

describe("the operator's turn once a layer echoes it", () => {
	const sent = (over: Partial<AiAgentSessionState> = {}): AiAgentSessionState =>
		apply(started(over), {
			type: "prompt",
			text: "make the README",
			key: "k1",
			timestamp: SENT_AT,
		})[0];

	const echo = (item: TranscriptItem): AiAgentSessionMsg => ({
		type: "event",
		sessionId: "session-1",
		event: {kind: "item", item},
	});

	it("survives once, in place, under the layer's own id", () => {
		const [state] = apply(sent(), echo(userItem("pi-7", "make the README")));
		expect(state.transcript.items).toEqual([
			{
				kind: "user",
				id: userItem("pi-7").id,
				timestamp: userItem("pi-7").timestamp,
				text: "make the README",
			},
		]);
	});

	it("keeps its position rather than moving to the end of the tail", () => {
		const [replied] = apply(sent(), echo(assistantItem("a1", "on it")));
		const [state] = apply(replied, echo(userItem("pi-7", "make the README")));
		expect(state.transcript.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
	});

	it("stays exactly once on a layer that never echoes it", () => {
		const [replied] = apply(sent(), echo(assistantItem("a1", "on it")));
		expect(replied.transcript.items).toMatchObject([
			{kind: "user", id: promptItemId("k1"), local: true},
			{kind: "assistant", id: assistantItem("a1").id},
		]);
	});

	it("does not swallow a second deliberate send of the same text", () => {
		const [again] = apply(
			{...sent(), phase: "ready"},
			{
				type: "prompt",
				text: "make the README",
				key: "k2",
				timestamp: SENT_AT + 1,
			},
		);
		expect(again.transcript.items.map((item) => item.id)).toEqual([
			promptItemId("k1"),
			promptItemId("k2"),
		]);
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
		expect(asked.permissions).toEqual({
			"req-1": {request: card, seq: 1, progress: {status: "open"}},
		});
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

		const [prompted, cmds] = apply(state, {
			type: "prompt",
			text: "hello",
			key: "k1",
			timestamp: SENT_AT,
		});
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
	const raised = (over: Partial<AiAgentSessionState> = {}): AiAgentSessionState =>
		started({
			permissions: {"req-1": pendingPermission({request: card, seq: 4})},
			permissionsRaised: 4,
			...over,
		});

	const answerOnce = (
		state: AiAgentSessionState,
	): readonly [AiAgentSessionState, ReadonlyArray<AiAgentSessionCmd>] =>
		apply(state, {type: "answer", request: "req-1", decision: "allow-once"});

	it("keeps the card, marks it answering and asks the layer to decide it", () => {
		const [state, cmds] = answerOnce(raised());
		expect(state.permissions["req-1"]).toEqual({
			request: card,
			seq: 4,
			progress: {status: "answering", decision: "allow-once"},
		});
		expect(cmds).toEqual([
			{type: "aiAgent.republish"},
			{type: "aiAgent.answer", request: "req-1", seq: 4, decision: "allow-once"},
		]);
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

	// The second click, and the other window over this process: one shared card, one answer.
	it("refuses a second answer while the first is awaiting confirmation", () => {
		const [answering] = answerOnce(raised());
		const [twice, cmds] = apply(answering, {
			type: "answer",
			request: "req-1",
			decision: "deny",
		});
		expect(twice.failure?.reason).toBe("awaiting-confirmation");
		expect(twice.permissions["req-1"]?.progress).toEqual({
			status: "answering",
			decision: "allow-once",
		});
		expect(cmds).toEqual([]);
	});

	it("refuses another answer to a card whose outcome is unknown", () => {
		const [state, cmds] = answerOnce(
			raised({
				permissions: {
					"req-1": pendingPermission({
						request: card,
						seq: 4,
						progress: {status: "unresolved", decision: "deny"},
					}),
				},
			}),
		);
		expect(state.failure?.reason).toBe("unresolved");
		expect(cmds).toEqual([]);
	});

	it("drops the card on the confirmation that names its own raising", () => {
		const [answering] = answerOnce(raised());
		const [confirmed, cmds] = apply(answering, {type: "answered", request: "req-1", seq: 4});
		expect(confirmed.permissions).toEqual({});
		expect(confirmed.failure).toBeNull();
		expect(cmds).toEqual([{type: "aiAgent.republish"}]);
	});

	// The card is still there while the confirmation is out — the delayed-confirmation case.
	it("leaves the card standing until its confirmation arrives", () => {
		const [answering] = answerOnce(raised());
		expect(Object.keys(answering.permissions)).toEqual(["req-1"]);
	});

	it("lets the backend's own resolution settle a card whose answer is still out", () => {
		const [answering] = answerOnce(raised());
		const [settled] = apply(answering, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "permission-resolved", request: "req-1", decision: "allow-once"},
		});
		expect(settled.permissions).toEqual({});
	});

	it("refuses a confirmation for a later raising of the same id", () => {
		const [answering] = answerOnce(raised());
		const [reraised] = apply(answering, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "permission", request: "req-1", detail: card},
		});
		const [stale, cmds] = apply(reraised, {type: "answered", request: "req-1", seq: 4});
		expect(stale.permissions["req-1"]).toEqual({
			request: card,
			seq: 5,
			progress: {status: "open"},
		});
		expect(cmds).toEqual([]);
	});

	it("drops a card the layer says it no longer holds", () => {
		const [answering] = answerOnce(raised());
		const [state] = apply(answering, {
			type: "answerFailed",
			request: "req-1",
			seq: 4,
			failure: {tag: "tuval/ai-agent/UnknownRequest", reason: null, detail: "nothing pending"},
		});
		expect(state.permissions).toEqual({});
		expect(state.failure?.tag).toBe("tuval/ai-agent/UnknownRequest");
	});

	it("leaves a card whose answer failed for any other reason unresolved", () => {
		const [answering] = answerOnce(raised());
		const [state] = apply(answering, {
			type: "answerFailed",
			request: "req-1",
			seq: 4,
			failure: {tag: "tuval/ai-agent/TransportError", reason: "disconnected", detail: "gone"},
		});
		expect(state.permissions["req-1"]?.progress).toEqual({
			status: "unresolved",
			decision: "allow-once",
		});
		expect(state.failure?.reason).toBe("disconnected");
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
	const running = (over: Partial<AiAgentSessionState> = {}): AiAgentSessionState =>
		started({
			phase: "prompting",
			transcript: {
				items: [userItem("u0"), assistantItem("a1"), toolItem("t2")],
				omitted: initialState("/x").transcript.omitted,
			},
			...over,
		});

	const phaseEvent = (phase: AiAgentSessionState["phase"]): AiAgentSessionMsg => ({
		type: "event",
		sessionId: "session-1",
		event: {kind: "phase", phase},
	});

	it("asks the layer to stop and marks the turn, without declaring the session ready", () => {
		const [state, cmds] = apply(running(), {type: "interrupt", at: SENT_AT});
		expect(state.phase).toBe("prompting");
		expect(state.interruption).toEqual({requestedAt: SENT_AT});
		expect(state.interrupted).toBe("a1");
		expect(cmds).toEqual([{type: "aiAgent.interrupt"}]);
	});

	it("keeps refusing a prompt while the interruption is outstanding", () => {
		const [asked] = apply(running(), {type: "interrupt", at: SENT_AT});
		const [next, cmds] = apply(asked, {
			type: "prompt",
			text: "never mind, do this",
			key: "k9",
			timestamp: SENT_AT + 1,
		});
		expect(next.failure?.reason).toBe("no-session");
		expect(cmds).toEqual([]);
	});

	// The delayed case: the abort is in flight and the backend has said nothing yet, so the request
	// is still outstanding and the turn's own items keep landing on the tail.
	it("stays outstanding while the turn's events keep arriving", () => {
		const [asked] = apply(running(), {type: "interrupt", at: SENT_AT});
		const [next] = apply(asked, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "item", item: assistantItem("a3", "still going")},
		});
		expect(next.phase).toBe("prompting");
		expect(next.interruption).toEqual({requestedAt: SENT_AT});
	});

	// The refusal case as the generic contract can see it: `interrupt` declares no error channel and
	// both layers log a refused abort, so a refusal reaches the core as nothing at all. The session
	// must therefore stay busy with the request on the record, never fall back to ready.
	it("leaves a refused abort outstanding rather than fabricating a stop", () => {
		const [asked] = apply(running(), {type: "interrupt", at: SENT_AT});
		const [again, cmds] = apply(asked, {type: "interrupt", at: SENT_AT + 3_000});
		expect(again.phase).toBe("prompting");
		// The clock is the operator's first ask, so a second press does not restart the wait.
		expect(again.interruption).toEqual({requestedAt: SENT_AT});
		expect(cmds).toEqual([{type: "aiAgent.interrupt"}]);
	});

	it("comes back to ready only on the layer's own confirming event", () => {
		const [asked] = apply(running(), {type: "interrupt", at: SENT_AT});
		const [confirmed] = apply(asked, phaseEvent("ready"));
		expect(confirmed.phase).toBe("ready");
		expect(confirmed.interruption).toBeNull();
		expect(confirmed.interrupted).toBe("a1");
	});

	it("settles the request on a failed turn too, since that turn has stopped as well", () => {
		const [asked] = apply(running(), {type: "interrupt", at: SENT_AT});
		const [failed] = apply(asked, {
			type: "event",
			sessionId: "session-1",
			event: {
				kind: "failure",
				failure: {tag: "tuval/ai-agent/PromptError", reason: "refused", detail: "no"},
			},
		});
		expect(failed.phase).toBe("ready");
		expect(failed.interruption).toBeNull();
	});

	it("takes a deliberate prompt once the confirmation landed, and sends nothing on its own", () => {
		const [asked] = apply(running(), {type: "interrupt", at: SENT_AT});
		const [confirmed, idle] = apply(asked, phaseEvent("ready"));
		expect(idle).toEqual([]);
		const [sent, cmds] = apply(confirmed, {
			type: "prompt",
			text: "try again",
			key: "k4",
			timestamp: SENT_AT + 10,
		});
		expect(sent.phase).toBe("prompting");
		expect(sent.interrupted).toBeNull();
		expect(cmds).toEqual([{type: "aiAgent.prompt", text: "try again", key: "k4"}]);
	});

	// A late `ready` from the settled interruption, and a late frame from a session this process has
	// already replaced: neither may re-open a request nobody made.
	it("leaves a settled interruption settled when a late event arrives", () => {
		const [asked] = apply(running(), {type: "interrupt", at: SENT_AT});
		const [confirmed] = apply(asked, phaseEvent("ready"));
		const [late] = apply(confirmed, phaseEvent("ready"));
		expect(late.interruption).toBeNull();
		expect(machine.identity?.ofMsg?.(phaseEvent("ready"))).toBe("session-1");
	});

	// Stopping a turn, ending the backend's session and stopping the process are three acts, and
	// this is only the first: nothing here tears a session down or drops what the backend owns.
	it("asks for the turn only, leaving the session and its history alone", () => {
		const before = running();
		const [state, cmds] = apply(before, {type: "interrupt", at: SENT_AT});
		expect(cmds).toEqual([{type: "aiAgent.interrupt"}]);
		expect(state.sessionId).toBe(before.sessionId);
		expect(state.connection).toBe(before.connection);
		expect(state.phase).not.toBe("gone");
		expect(state.transcript.items).toEqual(before.transcript.items);
		expect(state.permissions).toEqual(before.permissions);
	});

	it("does nothing when no turn is running", () => {
		const [state, cmds] = apply(started(), {type: "interrupt", at: SENT_AT});
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

/**
 * Four points in one send's life, kept apart: the core admitted it, the layer took the handoff
 * without refusing, the backend ran the turn, and the session lost its footing under it. The third
 * is why the turn's end appears here at all — both rows return from `prompt` at the send (#8018),
 * so the handoff proves nothing about the backend and only the turn's own end does.
 */
describe("a send's outcome, under its own key", () => {
	const turnEnded: AiAgentSessionMsg = {
		type: "event",
		sessionId: "session-1",
		event: {kind: "phase", phase: "ready"},
	};

	const prompt = (key: string): AiAgentSessionMsg => ({
		type: "prompt",
		text: "ship it",
		key,
		timestamp: SENT_AT,
	});

	it("records an admission refusal against the key that earned it", () => {
		const [refused, cmds] = apply(started({phase: "prompting"}), prompt("k1"));
		expect(cmds).toEqual([]);
		expect(refused.sends).toEqual([{key: "k1", state: "refused", failure: refused.failure}]);
		expect(refused.failure?.tag).toBe("tuval/ai-agent/PromptError");
	});

	it("leaves an admitted send pending through a handoff nobody refused", () => {
		const [admitted] = apply(started(), prompt("k1"));
		expect(admitted.sends).toEqual([{key: "k1", state: "pending"}]);

		const [handed] = apply(admitted, {type: "sent", key: "k1", failure: null});
		expect(handed.sends).toEqual([{key: "k1", state: "pending"}]);
		expect(handed.phase).toBe("prompting");
	});

	it("accepts the send once the turn the backend ran comes to an end", () => {
		const [admitted] = apply(started(), prompt("k1"));
		const [handed] = apply(admitted, {type: "sent", key: "k1", failure: null});
		const [done] = apply(handed, turnEnded);
		expect(done.sends).toEqual([{key: "k1", state: "accepted"}]);
		expect(done.phase).toBe("ready");
	});

	it("holds the send through the turn the layer is still narrating", () => {
		const [admitted] = apply(started(), prompt("k1"));
		const [narrating] = apply(admitted, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "phase", phase: "prompting"},
		});
		expect(narrating.sends).toEqual([{key: "k1", state: "pending"}]);
	});

	/**
	 * The refusal #8005 is about: the layer took the text without refusing, and the backend said no
	 * a round trip later. It has no caller left by then (`pi/ai-agent/refusals.ts`), so it rides the
	 * event stream — and the send it names is still the one in flight, which is what keeps the text
	 * recoverable in the window that minted the key.
	 */
	it("settles a backend refusal that arrives on the event stream after the handoff", () => {
		const [admitted] = apply(started(), prompt("k1"));
		const [handed] = apply(admitted, {type: "sent", key: "k1", failure: null});
		const failure = {
			tag: "tuval/ai-agent/PromptError",
			reason: "refused",
			detail: "the pin refused the turn",
		};
		const [answered] = apply(handed, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "failure", failure},
		});
		expect(answered.sends).toEqual([{key: "k1", state: "refused", failure}]);
		expect(answered).toMatchObject({phase: "ready", failure});
	});

	/** The other arm of the same story: the transport dies after the handoff, so the stream fails. */
	it("settles a send the stream failed under after the handoff, uncertain", () => {
		const [admitted] = apply(started(), prompt("k1"));
		const [handed] = apply(admitted, {type: "sent", key: "k1", failure: null});
		const failure = {
			tag: "tuval/ai-agent/TransportError",
			reason: "disconnected",
			detail: "the socket closed mid-turn",
		};
		const [lost] = apply(handed, {type: "failed", failure});
		expect(lost.sends).toEqual([{key: "k1", state: "uncertain", failure}]);
	});

	/** A turn that ended is a turn the text crossed for, so nothing later reopens the send. */
	it("leaves an accepted send alone when the session goes away afterwards", () => {
		const [admitted] = apply(started(), prompt("k1"));
		const [done] = apply(admitted, turnEnded);
		const [gone] = apply(done, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "phase", phase: "gone"},
		});
		expect(gone.sends).toEqual([{key: "k1", state: "accepted"}]);
	});

	/** The refusal that does reach the caller: the layer refused the handoff itself. */
	it("settles a refused handoff on its own key, and walks the phase back as `failed` would", () => {
		const [admitted] = apply(started(), prompt("k1"));
		const failure = {
			tag: "tuval/ai-agent/PromptError",
			reason: "no-session",
			detail: "start has not opened a session on this layer",
		};
		const [answered] = apply(admitted, {type: "sent", key: "k1", failure});
		expect(answered.sends).toEqual([{key: "k1", state: "refused", failure}]);
		expect(answered).toMatchObject({phase: "ready", failure});
	});

	it("leaves a send the transport died under uncertain, never refused", () => {
		const [admitted] = apply(started(), prompt("k1"));
		const failure = {
			tag: "tuval/ai-agent/TransportError",
			reason: "disconnected",
			detail: "the socket closed",
		};
		const [lost] = apply(admitted, {type: "failed", failure});
		expect(lost.sends).toEqual([{key: "k1", state: "uncertain", failure}]);
	});

	it("leaves a send uncertain when the session goes away under it", () => {
		const [admitted] = apply(started(), prompt("k1"));
		const [gone] = apply(admitted, {
			type: "event",
			sessionId: "session-1",
			event: {kind: "phase", phase: "gone"},
		});
		expect(gone.sends).toEqual([{key: "k1", state: "uncertain", failure: null}]);
	});

	/**
	 * Criterion 8. `prompting` is reached at admission, so an Escape can land while the layer is
	 * still deciding. The interrupt leaves the send where it stood, and the refusal that arrives a
	 * moment later still finds it there — which is what leaves the window a copy to offer.
	 */
	it("leaves a send in flight alone when the operator interrupts, so a later refusal still settles it", () => {
		const [admitted] = apply(started(), prompt("k1"));
		const [cut] = apply(admitted, {type: "interrupt", at: SENT_AT});
		expect(cut.sends).toEqual([{key: "k1", state: "pending"}]);

		const failure = {
			tag: "tuval/ai-agent/PromptError",
			reason: "refused",
			detail: "the pin refused the prompt",
		};
		const [answered] = apply(cut, {type: "sent", key: "k1", failure});
		expect(answered.sends).toEqual([{key: "k1", state: "refused", failure}]);
	});

	/** The other half: a turn the layer really took still releases its window's copy when it ends. */
	it("accepts an interrupted send once the layer narrates the turn's end", () => {
		const [admitted] = apply(started(), prompt("k1"));
		const [handed] = apply(admitted, {type: "sent", key: "k1", failure: null});
		const [cut] = apply(handed, {type: "interrupt", at: SENT_AT});
		const [done] = apply(cut, turnEnded);
		expect(done.sends).toEqual([{key: "k1", state: "accepted"}]);
	});

	/**
	 * The two-window race, at the core. One window's prompt is admitted and the other's is refused
	 * because the session is no longer `ready`; both outcomes stand, each under its own key, so
	 * neither window can read the other's answer as its own.
	 */
	it("keeps two racing windows' outcomes apart", () => {
		const [first] = apply(started(), prompt("k-left"));
		const [both] = apply(first, prompt("k-right"));
		expect(both.sends).toEqual([
			{key: "k-left", state: "pending"},
			{key: "k-right", state: "refused", failure: both.failure},
		]);

		const [handed] = apply(both, {type: "sent", key: "k-left", failure: null});
		const [answered] = apply(handed, turnEnded);
		expect(answered.sends).toEqual([
			{key: "k-right", state: "refused", failure: both.failure},
			{key: "k-left", state: "accepted"},
		]);
	});
});

describe("the Cmd each Msg answers for", () => {
	const cases: ReadonlyArray<
		readonly [AiAgentSessionState, AiAgentSessionMsg, ReadonlyArray<AiAgentSessionCmd["type"]>]
	> = [
		[initialState("/repo"), {type: "start", cwd: "/repo", resume: null}, ["aiAgent.start"]],
		[started({phase: "starting"}), {type: "started", sessionId: "s"}, []],
		[started(), {type: "prompt", text: "hi", key: "k", timestamp: SENT_AT}, ["aiAgent.prompt"]],
		[started({phase: "prompting"}), {type: "sent", key: "k", failure: null}, []],
		[
			started(),
			{type: "event", sessionId: "session-1", event: {kind: "phase", phase: "ready"}},
			[],
		],
		[
			started({permissions: {"req-1": pendingPermission({request: card})}}),
			{type: "answer", request: "req-1", decision: "deny"},
			["aiAgent.republish", "aiAgent.answer"],
		],
		[
			started({
				permissions: {
					"req-1": pendingPermission({
						request: card,
						progress: {status: "answering", decision: "deny"},
					}),
				},
			}),
			{type: "answered", request: "req-1", seq: 1},
			["aiAgent.republish"],
		],
		[
			started({
				permissions: {
					"req-1": pendingPermission({
						request: card,
						progress: {status: "answering", decision: "deny"},
					}),
				},
			}),
			{
				type: "answerFailed",
				request: "req-1",
				seq: 1,
				failure: {tag: "tuval/ai-agent/TransportError", reason: "disconnected", detail: "gone"},
			},
			["aiAgent.republish"],
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
		[started({phase: "prompting"}), {type: "interrupt", at: SENT_AT}, ["aiAgent.interrupt"]],
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
