/**
 * What `start` hands the SDK, what it hands back, and how it refuses.
 *
 * Every message the scripted `Query` replays is a golden fixture captured from a real run
 * (`../history/fixtures/PROVENANCE.md`): the `Options` object is ours to assert, but the frames the
 * layer reads to find the session id are not something a test may invent.
 */

import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Logger, Option, Stream} from "effect";
import {Mode} from "../../ai-agent/ports/index.ts";
import {TUVAL_SERVER_NAME, wireNameOf} from "../tools/index.ts";
import {
	CWD,
	MODES,
	messages,
	on,
	rows,
	SESSION_ID,
	START_EVENTS,
	TOOL_SESSION_ID,
} from "./fixtures/harness.ts";

/**
 * The info lines a run wrote. `start` reports the SDK pin beside the CLI version the init frame
 * named, and that pair is the only place SDK/CLI drift is visible, so it is asserted rather than
 * trusted (founder ruling on #7580).
 */
const logged = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<ReadonlyArray<string>, E> =>
	Effect.suspend(() => {
		const lines: Array<string> = [];
		const capture = Logger.layer([
			Logger.make(({logLevel, message}) => {
				if (logLevel !== "Info") return;
				lines.push(String(Array.isArray(message) ? message[0] : message));
			}),
		]);
		return effect.pipe(Effect.provide(capture), Effect.as(lines as ReadonlyArray<string>));
	});

const failure = (exit: Exit.Exit<unknown, unknown>): {_tag?: string; reason?: string} =>
	Exit.isFailure(exit)
		? ((Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ?? {}) as {
				_tag?: string;
				reason?: string;
			})
		: {};

describe("start opens one streaming query", () => {
	it.effect("resolves the session id the init frame named", () =>
		on({}, (agent) =>
			Effect.gen(function* () {
				const session = yield* agent.start({cwd: CWD});
				assert.strictEqual(session.sessionId, SESSION_ID);
			}),
		),
	);

	it.effect("hands the SDK the cwd, mode, tools, server, callback and env", () =>
		on({allowedTools: ["mcp__other__thing"], model: "claude-fable-5-1"}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const options = scripted.opened[0]?.record.options;
				assert.isDefined(options);
				assert.strictEqual(options?.cwd, CWD);
				assert.strictEqual(options?.permissionMode, "default");
				assert.strictEqual(options?.model, "claude-fable-5-1");
				assert.deepStrictEqual(options?.allowedTools, [
					wireNameOf("spawn"),
					wireNameOf("send"),
					wireNameOf("read"),
					"mcp__other__thing",
				]);
				assert.deepStrictEqual(Object.keys(options?.mcpServers ?? {}), [TUVAL_SERVER_NAME]);
				assert.isFunction(options?.canUseTool);
				assert.isString(options?.env?.USER);
				assert.notStrictEqual(options?.env?.USER, "");
				// SDK/CLI drift is accepted for this slice, so the executable is never pinned: the
				// CLI is whatever `claude` on PATH is (founder ruling on #7580).
				assert.isUndefined(options?.pathToClaudeCodeExecutable);
				// A fresh session names no `resume`, so `continue` cannot be implied either.
				assert.isUndefined(options?.resume);
			}),
		),
	);

	it.effect("opens exactly one query for the whole session", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("first");
				yield* agent.prompt("second");
				assert.lengthOf(scripted.opened, 1);
			}),
		),
	);

	it.effect("logs the SDK pin beside the CLI version the init frame named", () =>
		Effect.gen(function* () {
			const lines = yield* logged(on({version: "9.9.9-test"}, (agent) => agent.start({cwd: CWD})));
			// `claude_code_version` off the captured `init` fixture, which is a real run's frame.
			const line = lines.find((each) => each.includes("SDK 9.9.9-test"));
			assert.isDefined(line);
			assert.include(line ?? "", "CLI 2.1.259");
			assert.include(line ?? "", SESSION_ID);
		}),
	);

	it.effect("emits starting, the init's own events, then the mode list", () =>
		on({modes: MODES}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				assert.deepStrictEqual(yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS)), [
					{kind: "phase", phase: "starting"},
					{kind: "phase", phase: "ready"},
					{kind: "usage", model: "claude-fable-5-1", inputTokens: 0, outputTokens: 0, cost: 0},
					// The opening mode, not the layer's raw held `null`: nothing has called `setMode`, so
					// what the query opened on is the row's own `permissionMode` (#7828).
					{kind: "mode", current: Mode.make("default"), available: MODES},
				]);
			}),
		),
	);

	it.effect("announces the mode the query was opened on, not the layer's held null (#7828)", () =>
		on({permissionMode: Mode.make("plan"), modes: MODES}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				const announced = events[START_EVENTS - 1];
				assert.deepStrictEqual(announced, {
					kind: "mode",
					current: Mode.make(scripted.opened[0]?.record.options.permissionMode ?? ""),
					available: MODES,
				});
			}),
		),
	);
});

describe("start on a resume", () => {
	it.effect("passes the session id through and reads that session's store", () =>
		on({rows: rows()}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD, resume: TOOL_SESSION_ID});
				assert.deepStrictEqual(scripted.reads, [{sessionId: TOOL_SESSION_ID, dir: CWD}]);
				assert.strictEqual(scripted.opened[0]?.record.options.resume, TOOL_SESSION_ID);
			}),
		),
	);

	it.effect("refuses a session the store does not hold as SessionNotFound", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({}, (agent) => agent.start({cwd: CWD, resume: "00000000-0000-4000-8000-00000000dead"})),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/StartError");
			assert.strictEqual(failure(exit).reason, "session-not-found");
		}),
	);

	it.effect("takes the session down rather than leaving it on starting", () =>
		on({}, (agent) =>
			Effect.gen(function* () {
				yield* Effect.exit(agent.start({cwd: CWD, resume: "00000000-0000-4000-8000-00000000dead"}));
				assert.deepStrictEqual(yield* Stream.runCollect(Stream.take(agent.events, 2)), [
					{kind: "phase", phase: "starting"},
					{kind: "phase", phase: "gone"},
				]);
			}),
		),
	);

	it.effect("resolves the cards it does not hold so a restored window drops them", () =>
		on(
			// The tool turn's first frames open a `tool_use` this scripted run never answers, so the
			// stored session carries exactly one call the layer cannot hold a card for.
			{rows: rows().slice(0, 2)},
			(agent) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD, resume: TOOL_SESSION_ID});
					const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
					assert.deepStrictEqual(events[START_EVENTS], {
						kind: "permission-resolved",
						request: "toolu_00000000000000000010",
						decision: "deny",
					});
				}),
		),
	);

	it.effect("emits no resolution when every stored call already settled", () =>
		on({rows: rows(), opening: messages("tool-turn")}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD, resume: TOOL_SESSION_ID});
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
				assert.notStrictEqual(events[START_EVENTS]?.kind, "permission-resolved");
			}),
		),
	);
});

describe("setMode", () => {
	it.effect("reaches Query.setPermissionMode and announces the new state", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setMode(Mode.make("plan"));
				assert.deepStrictEqual(scripted.opened[0]?.record.modes, ["plan"]);
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
				assert.deepStrictEqual(events[START_EVENTS], {
					kind: "mode",
					current: Mode.make("plan"),
					available: MODES,
				});
			}),
		),
	);

	it.effect("opens a later session on the mode it announced, not the row's static one", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setMode(Mode.make("plan"));
				yield* agent.start({cwd: CWD});
				assert.strictEqual(scripted.opened[1]?.record.options.permissionMode, "plan");
			}),
		),
	);

	it.effect("opens the first session on a mode set before it, which is permitted", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.setMode(Mode.make("plan"));
				yield* agent.start({cwd: CWD});
				assert.strictEqual(scripted.opened[0]?.record.options.permissionMode, "plan");
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.deepStrictEqual(events[START_EVENTS - 1], {
					kind: "mode",
					current: Mode.make("plan"),
					available: MODES,
				});
			}),
		),
	);

	it.effect("refuses a mode the row does not advertise", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({}, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						yield* agent.setMode(Mode.make("acceptWhatever"));
					}),
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/ModeUnsupported");
		}),
	);

	it.effect("never offers bypassPermissions or dontAsk, even when the row names them", () =>
		Effect.gen(function* () {
			const named = [Mode.make("default"), Mode.make("bypassPermissions"), Mode.make("dontAsk")];
			const exit = yield* Effect.exit(
				on({modes: named}, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
						assert.deepStrictEqual(events[START_EVENTS - 1], {
							kind: "mode",
							current: Mode.make("default"),
							available: [Mode.make("default")],
						});
						yield* agent.setMode(Mode.make("bypassPermissions"));
					}),
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/ModeUnsupported");
		}),
	);
});
