/**
 * Pi's three kernel tools over the scripted bridge: what the session is offered, what one call
 * answers, and what a refusal does. `KernelBridge.scripted` is the whole world — no model, no
 * kernel — which is what makes every assertion below deterministic.
 *
 * A handler answers a `Promise`, which is the whole point of the seam, so each call is lifted back
 * into the test's Effect through `answered` below — object-notation `Effect.tryPromise` plus
 * `orDie`, the repo's sanctioned stand-in for the banned `Effect.promise` (#2736). A refusal is a
 * rejection, so it is read through `refusalOf`, which keeps the rejection out of the Effect.
 */

import type {
	AgentToolResult,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {assert, describe, it} from "@effect/vitest";
import {type Context, Effect, Schema} from "effect";
import {KernelBridge, type ScriptedKernel} from "../ai-agent/tools/KernelBridge.ts";
import {ProcessId} from "../process/process.ts";
import {ProgramId} from "../registry/program.ts";
import {customToolsOption} from "./server/AgentSessionHost.ts";
import {piKernelToolHandlers, piKernelTools, type ToolRun} from "./tools.ts";

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
 * is built the way the Pi layer builds the real one — `Effect.runPromiseWith` over the services the
 * caller was running under — so a handler here keeps this test's fiber services.
 */
const countingRun = (
	services: Context.Context<never>,
): {readonly run: ToolRun; readonly runs: () => number} => {
	let runs = 0;
	const run = Effect.runPromiseWith(services);
	return {
		run: (effect) => {
			runs++;
			return run(effect);
		},
		runs: () => runs,
	};
};

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

const answered = <A>(call: () => Promise<A>): Effect.Effect<A> =>
	Effect.tryPromise({try: call, catch: (cause) => new TestIo({cause})}).pipe(Effect.orDie);

/** The message of the rejection a call made, or the sentence that says it did not reject at all. */
const refusalOf = (call: () => Promise<unknown>): Effect.Effect<string> =>
	Effect.tryPromise({try: call, catch: (cause) => new TestIo({cause})}).pipe(
		Effect.match({
			onSuccess: () => "the handler answered instead of refusing",
			onFailure: ({cause}) =>
				cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
		}),
	);

const built = (rows: ScriptedKernel = table) =>
	Effect.gen(function* () {
		const bridge = yield* KernelBridge;
		const counting = countingRun(yield* Effect.context<never>());
		return {
			handlers: piKernelToolHandlers(bridge, counting.run),
			tools: piKernelTools(bridge, counting.run),
			runs: counting.runs,
		};
	}).pipe(Effect.provide(KernelBridge.scripted(rows)));

const textOf = (result: AgentToolResult<undefined>): string => {
	const first = result.content[0];
	assert.strictEqual(first?.type, "text", "a tool answered with something other than text");
	return first?.type === "text" ? first.text : "";
};

/** A tool's parameter schema as the model is handed it: plain JSON, which is what goes on the wire. */
const schemaOf = (tool: ToolDefinition): {type?: string; required?: ReadonlyArray<string>} =>
	JSON.parse(JSON.stringify(tool.parameters));

/**
 * The fifth argument Pi hands `execute`. These three tools never read it, and building a real one
 * would mean booting an extension runtime to prove that a definition routes to its own handler.
 */
// biome-ignore lint/plugin: an unread argument's only honest value is nothing; see above.
const NO_CONTEXT = undefined as unknown as ExtensionContext;

const executed = (
	tool: ToolDefinition,
	params: unknown,
): Effect.Effect<AgentToolResult<undefined>> =>
	answered(() =>
		(tool as ToolDefinition<never, undefined>).execute(
			"call-1",
			params as never,
			undefined,
			undefined,
			NO_CONTEXT,
		),
	);

describe("Pi's kernel tools", () => {
	it.effect("registers exactly three tools at their bare names, in order", () =>
		Effect.gen(function* () {
			const {tools} = yield* built();
			assert.deepStrictEqual(
				tools.map((one) => one.name),
				["spawn", "send", "read"],
			);
			for (const one of tools) {
				assert.isAbove(one.description.length, 0, `${one.name} carries no description`);
				assert.notInclude(one.description, scriptedProgram, `${one.name} names a program`);
				assert.strictEqual(schemaOf(one).type, "object", `${one.name} takes no object`);
			}
			assert.deepStrictEqual(
				tools.map((one) => schemaOf(one).required),
				[["program"], ["process", "port", "payload"], ["process", "port"]],
			);
		}),
	);

	it.effect("every handler runs its Effect through the runtime it was given", () =>
		Effect.gen(function* () {
			const {handlers, runs} = yield* built();
			yield* answered(() => handlers.spawn({program: scriptedProgram}));
			yield* answered(() =>
				handlers.send({process: scriptedProcess, port: "words", payload: "hi"}),
			);
			yield* answered(() => handlers.read({process: scriptedProcess, port: "echoed"}));
			assert.strictEqual(runs(), 3, "a handler ran its Effect outside the supplied runtime");
		}),
	);

	it.effect("each handler answers the bridge's own answer", () =>
		Effect.gen(function* () {
			const {handlers} = yield* built();

			const spawned = yield* answered(() => handlers.spawn({program: scriptedProgram}));
			assert.deepStrictEqual(JSON.parse(textOf(spawned)), {process: scriptedProcess});

			const sent = yield* answered(() =>
				handlers.send({process: scriptedProcess, port: "words", payload: "hi"}),
			);
			assert.deepStrictEqual(JSON.parse(textOf(sent)), {delivered: true, evicted: 0});

			const held = yield* answered(() => handlers.read({process: scriptedProcess, port: "echoed"}));
			assert.deepStrictEqual(JSON.parse(textOf(held)), {empty: false, value: "HI"});
		}),
	);

	// The test's own timeout is the assertion: a `read` that waited on an empty port would run out
	// of it rather than answering.
	it.effect(
		"read on a port that has said nothing answers empty rather than waiting",
		() =>
			Effect.gen(function* () {
				const {handlers} = yield* built();
				const held = yield* answered(() =>
					handlers.read({process: scriptedProcess, port: "quiet"}),
				);
				assert.deepStrictEqual(JSON.parse(textOf(held)), {empty: true});
			}),
		{timeout: 1000},
	);

	// Pi's own tool-error channel is a rejected `execute` — `AgentToolResult` carries no error flag
	// and the agent loop renders a rejection as `createErrorToolResult(error.message)`. So the
	// assertion is the rejection's own message: it names the refusal, and it is the one refusal type
	// this module throws, never a raw Effect failure.
	it.effect("a bridge refusal is a KernelToolRefused rejection naming the refusal", () =>
		Effect.gen(function* () {
			const {handlers} = yield* built();

			const missing = yield* refusalOf(() => handlers.spawn({program: "nothing-registered"}));
			assert.include(missing, "KernelToolRefused");
			assert.include(missing, "tuval/claude/UnknownProgram");

			// A payload of the wrong kind: the tag and the kind the port takes both reach the model.
			const refused = yield* refusalOf(() =>
				handlers.send({process: scriptedProcess, port: "words", payload: 7}),
			);
			assert.include(refused, "tuval/claude/PortRefused");
			assert.include(refused, WORD_KIND);

			const nowhere = yield* refusalOf(() =>
				handlers.read({process: scriptedProcess, port: "absent"}),
			);
			assert.include(nowhere, "tuval/claude/UnknownPort");
		}),
	);

	it.effect("a definition's execute is the same handler, so the model reaches the bridge", () =>
		Effect.gen(function* () {
			const {tools} = yield* built();
			const [spawn, send, read] = tools;
			assert.isDefined(spawn);
			assert.isDefined(send);
			assert.isDefined(read);

			const spawned = yield* executed(spawn as ToolDefinition, {program: scriptedProgram});
			assert.deepStrictEqual(JSON.parse(textOf(spawned)), {process: scriptedProcess});

			const sent = yield* executed(send as ToolDefinition, {
				process: scriptedProcess,
				port: "words",
				payload: "hi",
			});
			assert.deepStrictEqual(JSON.parse(textOf(sent)), {delivered: true, evicted: 0});

			const held = yield* executed(read as ToolDefinition, {
				process: scriptedProcess,
				port: "echoed",
			});
			assert.deepStrictEqual(JSON.parse(textOf(held)), {empty: false, value: "HI"});
		}),
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

describe("the customTools option the host passes on", () => {
	// The flag off is an empty list, and the host then passes no key at all. Both spellings open the
	// same session at this pin — `agent-session.js:144` reads `config.customTools ?? []` and nothing
	// branches on the key — so what this pins is the call site's shape, not a behaviour difference.
	it("passes no key at all when the flag left the list empty", () => {
		assert.deepStrictEqual(customToolsOption({}), {});
		assert.deepStrictEqual(customToolsOption({customTools: []}), {});
	});

	it("passes the tools, copied off the readonly list, when there are some", () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const {tools} = yield* built();
				const passed = customToolsOption({customTools: tools});
				assert.deepStrictEqual(
					passed.customTools?.map((one) => one.name),
					["spawn", "send", "read"],
				);
				assert.notStrictEqual(passed.customTools, tools, "the readonly list was passed as-is");
			}),
		));
});
