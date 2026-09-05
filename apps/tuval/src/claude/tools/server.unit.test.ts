/**
 * The tool server over the scripted bridge: what the model is offered, and what one call answers.
 * Nothing here reaches a kernel — `KernelBridge.scripted` is the whole world, which is what makes
 * every assertion below deterministic.
 *
 * A tool handler answers a `Promise`, which is the whole point of the seam, so each call is lifted
 * back into the test's Effect through `answered` below — object-notation `Effect.tryPromise` plus
 * `orDie`, the repo's sanctioned stand-in for the banned `Effect.promise` (#2736).
 */

import {assert, describe, it} from "@effect/vitest";
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import {type Context, Effect, Schema} from "effect";
import {ProcessId} from "../../process/process.ts";
import {ProgramId} from "../../registry/program.ts";
import {KernelBridge, type ScriptedKernel} from "./KernelBridge.ts";
import {type ToolRuntime, tuvalToolServer, wireNameOf} from "./server.ts";

const WORD_KIND = "text/v1";
const isWord = (payload: unknown): payload is string => typeof payload === "string";

const scriptedProgram = "under-test";
const scriptedProcess = ProcessId.make("p-scripted");

const table: ScriptedKernel = {
	[scriptedProcess]: {
		program: scriptedProgram,
		inPorts: {words: {kind: WORD_KIND, accepts: isWord}},
		outPorts: {echoed: ["HI"], quiet: []},
	},
};

/**
 * The per-process runtime, plus a count, so a handler that ran its Effect elsewhere is visible. It
 * is built the way `ClaudeAiAgent` builds the real one — `Effect.runPromiseWith` over the services
 * the caller was running under — so a handler here keeps this test's fiber services rather than
 * running on a bare default runtime.
 */
const countingRuntime = (
	services: Context.Context<never>,
): ToolRuntime & {readonly runs: () => number} => {
	let runs = 0;
	const run = Effect.runPromiseWith(services);
	return {
		runPromise: (effect) => {
			runs++;
			return run(effect);
		},
		runs: () => runs,
	};
};

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

const answered = <A>(call: () => Promise<A>): Effect.Effect<A> =>
	Effect.tryPromise({try: call, catch: (cause) => new TestIo({cause})}).pipe(Effect.orDie);

const server = () =>
	Effect.gen(function* () {
		const bridge = yield* KernelBridge;
		const run = countingRuntime(yield* Effect.context<never>());
		return {tools: tuvalToolServer(bridge, run), run};
	}).pipe(Effect.provide(KernelBridge.scripted(table)));

const textOf = (result: CallToolResult): string => {
	const first = result.content[0];
	assert.strictEqual(first?.type, "text", "a tool answered with something other than text");
	return first?.type === "text" ? first.text : "";
};

describe("the tuval tool server", () => {
	it.effect("registers exactly the three tools, on the tuval server, at their wire names", () =>
		Effect.gen(function* () {
			const {tools} = yield* server();
			assert.strictEqual(tools.name, "tuval");
			assert.deepStrictEqual(
				tools.tools.map((one) => one.name),
				["spawn", "send", "read"],
			);
			assert.deepStrictEqual(tools.wireNames, [
				"mcp__tuval__spawn",
				"mcp__tuval__send",
				"mcp__tuval__read",
			]);
			assert.strictEqual(wireNameOf("spawn"), "mcp__tuval__spawn");
			assert.strictEqual(tools.server.name, "tuval");
			assert.isDefined(tools.server.instance, "the server carries no in-process instance");
			for (const one of tools.tools) {
				assert.isAbove(one.description.length, 0, `${one.name} carries no description`);
				assert.notInclude(one.description, scriptedProgram, `${one.name} names a program`);
			}
		}),
	);

	it.effect("every handler runs its Effect through the runtime it was given", () =>
		Effect.gen(function* () {
			const {tools, run} = yield* server();
			yield* answered(() => tools.handlers.spawn({program: scriptedProgram}));
			yield* answered(() =>
				tools.handlers.send({process: scriptedProcess, port: "words", payload: "hi"}),
			);
			yield* answered(() => tools.handlers.read({process: scriptedProcess, port: "echoed"}));
			assert.strictEqual(run.runs(), 3, "a handler ran its Effect outside the supplied runtime");
		}),
	);

	it.effect("each handler answers a CallToolResult carrying the bridge's own answer", () =>
		Effect.gen(function* () {
			const {tools} = yield* server();

			const spawned = yield* answered(() => tools.handlers.spawn({program: scriptedProgram}));
			assert.isNotTrue(spawned.isError);
			assert.deepStrictEqual(JSON.parse(textOf(spawned)), {process: scriptedProcess});

			const sent = yield* answered(() =>
				tools.handlers.send({
					process: scriptedProcess,
					port: "words",
					payload: "hi",
				}),
			);
			assert.isNotTrue(sent.isError);
			assert.deepStrictEqual(JSON.parse(textOf(sent)), {delivered: true});

			const held = yield* answered(() =>
				tools.handlers.read({process: scriptedProcess, port: "echoed"}),
			);
			assert.isNotTrue(held.isError);
			assert.deepStrictEqual(JSON.parse(textOf(held)), {empty: false, value: "HI"});
		}),
	);

	it.effect("a bridge refusal is an isError result carrying the tag, never a throw", () =>
		Effect.gen(function* () {
			const {tools} = yield* server();

			const missing = yield* answered(() => tools.handlers.spawn({program: "nothing-registered"}));
			assert.isTrue(missing.isError);
			assert.include(textOf(missing), "tuval/claude/UnknownProgram");

			// A payload of the wrong kind: the tag and the kind the port takes both reach the model.
			const refused = yield* answered(() =>
				tools.handlers.send({
					process: scriptedProcess,
					port: "words",
					payload: 7,
				}),
			);
			assert.isTrue(refused.isError);
			assert.include(textOf(refused), "tuval/claude/PortRefused");
			assert.include(textOf(refused), WORD_KIND);

			const nowhere = yield* answered(() =>
				tools.handlers.read({process: scriptedProcess, port: "absent"}),
			);
			assert.isTrue(nowhere.isError);
			assert.include(textOf(nowhere), "tuval/claude/UnknownPort");
		}),
	);

	// The test's own timeout is the assertion: a `read` that waited on an empty port would run out
	// of it rather than answering.
	it.effect(
		"read on a port that has said nothing answers empty rather than waiting",
		() =>
			Effect.gen(function* () {
				const {tools} = yield* server();
				const held = yield* answered(() =>
					tools.handlers.read({process: scriptedProcess, port: "quiet"}),
				);
				assert.isNotTrue(held.isError);
				assert.deepStrictEqual(JSON.parse(textOf(held)), {empty: true});
			}),
		{timeout: 1000},
	);

	it.effect("the scripted bridge takes whatever program id it is handed", () =>
		Effect.gen(function* () {
			const spawned = yield* Effect.gen(function* () {
				const bridge = yield* KernelBridge;
				return yield* bridge.spawn(ProgramId.make(scriptedProgram));
			}).pipe(Effect.provide(KernelBridge.scripted(table)));
			assert.strictEqual(spawned, scriptedProcess);
		}),
	);
});
