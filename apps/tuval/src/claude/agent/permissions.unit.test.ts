/**
 * The permission prompt, driven end to end: the SDK's `canUseTool` call in, a card on the stream,
 * an operator decision, and the `PermissionResult` the parked promise resolves with.
 *
 * The callback's arguments are not a message, so there is no captured frame for them — they are
 * built here against the `CanUseTool` parameter type the SDK declares, which is what the checker
 * holds this file to.
 */

import type {CanUseTool, PermissionUpdate} from "@anthropic-ai/claude-agent-sdk";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Option, Stream} from "effect";
import type {TuvalAiAgentApi} from "../../ai-agent/service/index.ts";
import {DENIED_MESSAGE} from "./cards.ts";
import {CWD, on, START_EVENTS, settled} from "./fixtures/harness.ts";
import type {ScriptedSdk} from "./fixtures/scripted-query.ts";

const TOOL_USE_ID = "toolu_00000000000000000042";

const ALWAYS: ReadonlyArray<PermissionUpdate> = [
	{
		type: "addRules",
		rules: [{toolName: "Bash", ruleContent: "echo:*"}],
		behavior: "allow",
		destination: "session",
	},
];

type Context = Parameters<CanUseTool>[2];

/** The two fields the SDK always sends, and nothing else — what a bridge with no sentence renders. */
const bare = (over: Partial<Context> = {}): Context => ({
	signal: new AbortController().signal,
	toolUseID: TOOL_USE_ID,
	requestId: "req_00000000000000000001",
	...over,
});

const context = (over: Partial<Context> = {}): Context => ({
	...bare(),
	title: "Claude wants to run echo hello-tuval",
	displayName: "Run command",
	description: "Claude will run one shell command in this directory",
	...over,
});

/** The callback the layer handed the SDK, which is the only way in. */
const callback = (scripted: ScriptedSdk): CanUseTool => {
	const held = scripted.opened[0]?.record.options.canUseTool;
	assert.isFunction(held);
	return held as CanUseTool;
};

/** Everything after `start`'s own four events. */
const after = (agent: TuvalAiAgentApi, count: number) =>
	Effect.map(Stream.runCollect(Stream.take(agent.events, START_EVENTS + count)), (events) =>
		events.slice(START_EVENTS),
	);

const failure = (exit: Exit.Exit<unknown, unknown>): {_tag?: string} =>
	Exit.isFailure(exit)
		? ((Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ?? {}) as {_tag?: string})
		: {};

describe("a canUseTool call", () => {
	it.effect("becomes one permission event keyed by toolUseID, carrying the card", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const pending = callback(scripted)("Bash", {command: "echo hello-tuval"}, context());
				assert.deepStrictEqual(yield* after(agent, 1), [
					{
						kind: "permission",
						request: TOOL_USE_ID,
						detail: {
							title: "Claude wants to run echo hello-tuval",
							displayName: "Run command",
							description: "Claude will run one shell command in this directory",
							input: {command: "echo hello-tuval"},
							offersAlways: false,
						},
					},
				]);
				yield* agent.answer(TOOL_USE_ID, "deny");
				yield* settled(pending);
			}),
		),
	);

	it.effect("offers always exactly when the bridge suggested rules", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const pending = callback(scripted)("Bash", {}, context({suggestions: [...ALWAYS]}));
				const [event] = yield* after(agent, 1);
				assert.strictEqual(event?.kind, "permission");
				assert.isTrue(event?.kind === "permission" && event.detail.offersAlways);
				yield* agent.answer(TOOL_USE_ID, "deny");
				yield* settled(pending);
			}),
		),
	);

	it.effect("carries the blocked path and the ask rule as sentences on the card", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const pending = callback(scripted)(
					"Read",
					{file_path: "/etc/hosts"},
					context({
						description: "Claude will read one file",
						blockedPath: "/etc/hosts",
						matchedAskRule: {source: "projectSettings", toolName: "Read", ruleContent: "/etc/**"},
					}),
				);
				const [event] = yield* after(agent, 1);
				assert.strictEqual(
					event?.kind === "permission" ? event.detail.description : "",
					[
						"Claude will read one file",
						"Blocked path: /etc/hosts",
						"A permissions.ask rule in projectSettings (/etc/**) forced this prompt.",
					].join("\n"),
				);
				yield* agent.answer(TOOL_USE_ID, "deny");
				yield* settled(pending);
			}),
		),
	);

	it.effect("names the tool when the bridge rendered no sentence — AskUserQuestion included", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const pending = callback(scripted)("AskUserQuestion", {question: "which branch?"}, bare());
				const [event] = yield* after(agent, 1);
				assert.deepStrictEqual(event?.kind === "permission" ? event.detail : null, {
					title: "Claude wants to use AskUserQuestion",
					displayName: "AskUserQuestion",
					description: "",
					input: {question: "which branch?"},
					offersAlways: false,
				});
				yield* agent.answer(TOOL_USE_ID, "allow-once");
				yield* settled(pending);
			}),
		),
	);
});

describe("answer resolves the parked promise", () => {
	it.effect("allow-once allows and installs nothing", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const pending = callback(scripted)("Bash", {}, context({suggestions: [...ALWAYS]}));
				yield* after(agent, 1);
				yield* agent.answer(TOOL_USE_ID, "allow-once");
				assert.deepStrictEqual(yield* settled(pending), {behavior: "allow"});
			}),
		),
	);

	it.effect("allow-always echoes the suggestions as updatedPermissions, destinations intact", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const pending = callback(scripted)("Bash", {}, context({suggestions: [...ALWAYS]}));
				yield* after(agent, 1);
				yield* agent.answer(TOOL_USE_ID, "allow-always");
				assert.deepStrictEqual(yield* settled(pending), {
					behavior: "allow",
					updatedPermissions: [...ALWAYS],
				});
			}),
		),
	);

	it.effect("deny denies with a message the model can read", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const pending = callback(scripted)("Bash", {}, context());
				yield* after(agent, 1);
				yield* agent.answer(TOOL_USE_ID, "deny");
				assert.deepStrictEqual(yield* settled(pending), {
					behavior: "deny",
					message: DENIED_MESSAGE,
				});
			}),
		),
	);

	it.effect("closes the card on the stream", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const pending = callback(scripted)("Bash", {}, context());
				yield* agent.answer(TOOL_USE_ID, "allow-once");
				yield* settled(pending);
				const events = yield* after(agent, 2);
				assert.deepStrictEqual(events[1], {
					kind: "permission-resolved",
					request: TOOL_USE_ID,
					decision: "allow-once",
				});
			}),
		),
	);

	it.effect("refuses an id nothing is parked under", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({}, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						yield* agent.answer("toolu_nothing_is_parked_here", "allow-once");
					}),
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/UnknownRequest");
		}),
	);

	it.effect("refuses the same id twice — one card, one answer", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({}, (agent, scripted) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						const pending = callback(scripted)("Bash", {}, context());
						yield* after(agent, 1);
						yield* agent.answer(TOOL_USE_ID, "deny");
						yield* settled(pending);
						yield* agent.answer(TOOL_USE_ID, "deny");
					}),
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/UnknownRequest");
		}),
	);
});

describe("the abort signal", () => {
	it.effect("removes the card and resolves the promise so nothing stays blocked", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const abort = new AbortController();
				const pending = callback(scripted)("Bash", {}, context({signal: abort.signal}));
				yield* after(agent, 1);
				abort.abort();
				assert.deepStrictEqual(yield* settled(pending), {
					behavior: "deny",
					message: DENIED_MESSAGE,
				});
				// One subscription over one queue: a take consumes, so this reads the event after the
				// card rather than replaying from the start.
				const events = yield* Stream.runCollect(Stream.take(agent.events, 1));
				assert.deepStrictEqual(events[0], {
					kind: "permission-resolved",
					request: TOOL_USE_ID,
					decision: "deny",
				});
			}),
		),
	);
});
