/**
 * Every method of `TuvalAiAgent` driven through `ScriptedAiAgent.layer`, one describe per
 * behaviour the fixture set covers.
 *
 * Events are read with `Stream.take(n)` after the calls that queue them, never with a timer: the
 * queue is unbounded, so an offer lands before its call returns and a take of exactly the events
 * the script names is deterministic. A take of one more than a turn emitted would hang, which is
 * itself the ordering proof — the counts here are the assertion.
 */

import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Option, Stream} from "effect";
import type {ModelRef} from "../ports/index.ts";
import {
	cutShort,
	disconnects,
	disconnectTurn,
	history,
	interruptEvents,
	interruptedPromptTurn,
	interruptedTurn,
	mode,
	models,
	modes,
	PERMISSION_REQUEST,
	permissionRequest,
	permissionTurn,
	plainReply,
	plainReplyTurn,
	runningTool,
	SESSION_ID,
	settledTool,
	toolCall,
	toolCallTurn,
	usageEvent,
	usageReport,
	usageTurn,
} from "./fixtures/scripts.ts";
import {ScriptedAiAgent} from "./ScriptedAiAgent.ts";
import type {AgentScript} from "./script.ts";
import {TuvalAiAgent, type TuvalAiAgentApi} from "./TuvalAiAgent.ts";

const CWD = "/workspace/phoenix";

/** What `start` emits before any turn: starting, the mode list, the model list, ready. */
const START_EVENTS = 4;

const on = <A, E>(
	script: AgentScript,
	body: (agent: TuvalAiAgentApi) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
	Effect.gen(function* () {
		const agent = yield* TuvalAiAgent;
		return yield* body(agent);
	}).pipe(Effect.provide(ScriptedAiAgent.layer(script)), Effect.scoped);

/** The events a turn queued, with `start`'s four dropped. */
const afterStart = (agent: TuvalAiAgentApi, count: number) =>
	Effect.map(Stream.runCollect(Stream.take(agent.events, START_EVENTS + count)), (events) =>
		events.slice(START_EVENTS),
	);

const take = (agent: TuvalAiAgentApi, count: number) =>
	Stream.runCollect(Stream.take(agent.events, count));

/** The typed failure out of an exit, or undefined when the exit succeeded or died. */
const causeError = (exit: Exit.Exit<unknown, unknown>): {_tag?: string; reason?: string} =>
	Exit.isFailure(exit)
		? ((Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ?? {}) as {
				_tag?: string;
				reason?: string;
			})
		: {};

describe("start", () => {
	it.effect("returns the script's session id and announces the mode and model lists", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				const session = yield* agent.start({cwd: CWD});
				assert.strictEqual(session.sessionId, SESSION_ID);
				assert.deepStrictEqual(yield* take(agent, START_EVENTS), [
					{kind: "phase", phase: "starting"},
					{kind: "mode", current: modes.current, available: modes.available},
					{kind: "model", current: models.current, available: models.available},
					{kind: "phase", phase: "ready"},
				]);
			}),
		),
	);

	it.effect("replays the prior items when it resumes the session", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD, resume: SESSION_ID});
				const events = yield* take(agent, START_EVENTS + history.length);
				const replayed = events.filter((event) => event.kind === "item").map(({item}) => item);
				assert.deepStrictEqual(replayed, [...history]);
			}),
		),
	);

	it.effect("fails session-not-found when the resumed id is not this session's", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(agent.start({cwd: CWD, resume: "session-someone-else"}));
				const error = causeError(exit);
				assert.strictEqual(error._tag, "tuval/ai-agent/StartError");
				assert.strictEqual(error.reason, "session-not-found");
			}),
		),
	);
});

describe("prompt", () => {
	it.effect("replays the turn's events in the script's order", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("hello");
				assert.deepStrictEqual(yield* afterStart(agent, plainReplyTurn.length), [
					...plainReplyTurn,
				]);
			}),
		),
	);

	it.effect("drops a second prompt carrying a key this session already saw", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("hello", "key-1");
				yield* agent.prompt("hello", "key-1");
				yield* agent.setMode(mode("plan"));
				// The mode event lands right after the one turn: the repeat queued nothing at all.
				assert.deepStrictEqual(yield* afterStart(agent, plainReplyTurn.length + 1), [
					...plainReplyTurn,
					{kind: "mode", current: mode("plan"), available: modes.available},
				]);
			}),
		),
	);

	it.effect("fails no-session before start has been called", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				const error = causeError(yield* Effect.exit(agent.prompt("hello")));
				assert.strictEqual(error._tag, "tuval/ai-agent/PromptError");
				assert.strictEqual(error.reason, "no-session");
			}),
		),
	);
});

describe("a tool call", () => {
	it.effect("re-sends the same item id with the settled status and its result", () =>
		on(toolCall, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("read the readme");
				assert.deepStrictEqual(yield* afterStart(agent, toolCallTurn.length), [...toolCallTurn]);
				assert.strictEqual(runningTool.id, settledTool.id);
				assert.strictEqual(runningTool.status, "running");
				assert.strictEqual(settledTool.status, "ok");
				assert.strictEqual(settledTool.result.text, "# phoenix");
			}),
		),
	);
});

describe("permissions", () => {
	it.effect("answers the pending request and resolves it exactly once", () =>
		on(permissionTurn, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("delete the build dir");
				yield* agent.answer(PERMISSION_REQUEST, "deny");
				assert.deepStrictEqual(yield* afterStart(agent, 3), [
					{kind: "phase", phase: "prompting"},
					{kind: "permission", request: PERMISSION_REQUEST, detail: permissionRequest},
					{kind: "permission-resolved", request: PERMISSION_REQUEST, decision: "deny"},
				]);
				const again = causeError(yield* Effect.exit(agent.answer(PERMISSION_REQUEST, "deny")));
				assert.strictEqual(again._tag, "tuval/ai-agent/UnknownRequest");
			}),
		),
	);

	it.effect("refuses an answer to a request it never raised", () =>
		on(permissionTurn, (agent) =>
			Effect.gen(function* () {
				const error = causeError(yield* Effect.exit(agent.answer("req-nobody", "allow-once")));
				assert.strictEqual(error._tag, "tuval/ai-agent/UnknownRequest");
			}),
		),
	);
});

describe("modes", () => {
	it.effect("echoes a supported mode and refuses one it does not offer", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setMode(mode("plan"));
				assert.deepStrictEqual(yield* afterStart(agent, 1), [
					{kind: "mode", current: mode("plan"), available: modes.available},
				]);
				const error = causeError(yield* Effect.exit(agent.setMode(mode("yolo"))));
				assert.strictEqual(error._tag, "tuval/ai-agent/ModeUnsupported");
			}),
		),
	);
});

describe("models", () => {
	const sonnet = models.available[1];

	it.effect("echoes a supported model and refuses one it does not offer", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setModel(sonnet as ModelRef);
				assert.deepStrictEqual(yield* afterStart(agent, 1), [
					{kind: "model", current: sonnet, available: models.available},
				]);
				const error = causeError(
					yield* Effect.exit(agent.setModel({provider: "openai", id: "gpt", name: "GPT"})),
				);
				assert.strictEqual(error._tag, "tuval/ai-agent/ModelUnsupported");
			}),
		),
	);

	it.effect("runs the rest of the session on the model it switched to", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setModel(sonnet as ModelRef);
				yield* take(agent, START_EVENTS + 1);
				// A resumed start re-announces what the session is on, which is the picked model and
				// not the script's opening one — the switch outlives the turn it was made between.
				yield* agent.start({cwd: CWD, resume: SESSION_ID});
				const resumed = yield* take(agent, START_EVENTS + history.length);
				assert.deepStrictEqual(resumed.at(-2), {
					kind: "model",
					current: sonnet,
					available: models.available,
				});
			}),
		),
	);
});

describe("usage", () => {
	it.effect("reports the model, its token counts and its cost on the one stream", () =>
		on(usageReport, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("summarize");
				const events = yield* afterStart(agent, usageTurn.length);
				assert.deepStrictEqual(events, [...usageTurn]);
				assert.deepStrictEqual(
					events.find((event) => event.kind === "usage"),
					usageEvent,
				);
			}),
		),
	);
});

describe("interrupt", () => {
	it.effect("lands the cut-short assistant item, marked interrupted", () =>
		on(interruptedTurn, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("explain");
				yield* agent.interrupt;
				const events = yield* afterStart(
					agent,
					interruptedPromptTurn.length + interruptEvents.length,
				);
				assert.deepStrictEqual(events, [...interruptedPromptTurn, ...interruptEvents]);
				assert.strictEqual(cutShort.kind === "assistant" && cutShort.interrupted, true);
			}),
		),
	);
});

describe("page", () => {
	it.effect("walks back through history oldest-first and stops at the beginning", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				const newest = yield* agent.page(null, 3);
				assert.deepStrictEqual(newest.items, history.slice(6));
				assert.isTrue(newest.hasMore);

				const middle = yield* agent.page(cursor(newest.items), 3);
				assert.deepStrictEqual(middle.items, history.slice(3, 6));
				assert.isTrue(middle.hasMore);

				const oldest = yield* agent.page(cursor(middle.items), 3);
				assert.deepStrictEqual(oldest.items, history.slice(0, 3));
				assert.isFalse(oldest.hasMore);
			}),
		),
	);

	it.effect("returns a short last page and stops when the limit overshoots the beginning", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				const page = yield* agent.page(cursor(history.slice(2)), 5);
				assert.deepStrictEqual(page.items, history.slice(0, 2));
				assert.isFalse(page.hasMore);
			}),
		),
	);

	it.effect("fails unknown-cursor on an item this session never held", () =>
		on(plainReply, (agent) =>
			Effect.gen(function* () {
				const error = causeError(yield* Effect.exit(agent.page("history-nowhere", 3)));
				assert.strictEqual(error._tag, "tuval/ai-agent/PageError");
				assert.strictEqual(error.reason, "unknown-cursor");
			}),
		),
	);
});

describe("a scripted disconnect", () => {
	it.effect("fails the stream once and reconnects nothing on its own", () =>
		on(disconnects, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("hello");
				assert.deepStrictEqual(yield* afterStart(agent, disconnectTurn.length), [
					...disconnectTurn,
				]);

				const stream = causeError(yield* Effect.exit(Stream.runCollect(agent.events)));
				assert.strictEqual(stream._tag, "tuval/ai-agent/TransportError");
				assert.strictEqual(stream.reason, "disconnected");

				const next = causeError(yield* Effect.exit(agent.prompt("are you there")));
				assert.strictEqual(next._tag, "tuval/ai-agent/PromptError");
				assert.strictEqual(next.reason, "disconnected");

				const restart = causeError(yield* Effect.exit(agent.start({cwd: CWD})));
				assert.strictEqual(restart._tag, "tuval/ai-agent/StartError");
				assert.strictEqual(restart.reason, "transport");
			}),
		),
	);
});

/** The cursor for the page older than this one: its oldest item, which is the first. */
const cursor = (items: ReadonlyArray<{id: string}>): string => items[0]?.id ?? "";
