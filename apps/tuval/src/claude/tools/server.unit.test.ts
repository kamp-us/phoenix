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
import {aiAgentPortNames} from "../../ai-agent/handlers/index.ts";
import {mode, permission, prompt, transcriptPage} from "../../ai-agent/ports/index.ts";
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

const server = (rows: ScriptedKernel = table) =>
	Effect.gen(function* () {
		const bridge = yield* KernelBridge;
		const run = countingRuntime(yield* Effect.context<never>());
		return {tools: tuvalToolServer(bridge, run), run};
	}).pipe(Effect.provide(KernelBridge.scripted(rows)));

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
			assert.deepStrictEqual(JSON.parse(textOf(sent)), {delivered: true, evicted: 0});

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

/**
 * The AI agent's own `prompt` port behind the scripted kernel, so what a model reads back from
 * `send` is judged against the predicate production ships rather than a stand-in (#7991).
 */
const agentProcess = ProcessId.make("p-agent");
const agentTable: ScriptedKernel = {
	[agentProcess]: {
		program: "ai-agent",
		inPorts: {
			[aiAgentPortNames.prompt]: {kind: prompt.kind, accepts: prompt.is},
			[aiAgentPortNames.pageRequest]: {
				kind: transcriptPage.kind,
				accepts: transcriptPage.ends.request.is,
			},
			[aiAgentPortNames.permissionDecision]: {
				kind: permission.kind,
				accepts: permission.ends.decision.is,
			},
			[aiAgentPortNames.modeSet]: {kind: mode.kind, accepts: mode.ends.set.is},
		},
		outPorts: {},
	},
};

describe("send, on the AI agent's prompt port", () => {
	it.effect("refuses an unstamped prompt at the send instead of answering delivered", () =>
		Effect.gen(function* () {
			const {tools} = yield* server(agentTable);
			const refused = yield* answered(() =>
				tools.handlers.send({
					process: agentProcess,
					port: aiAgentPortNames.prompt,
					payload: {text: "hi", key: "child-1"},
				}),
			);
			assert.isTrue(refused.isError, "an unstamped prompt was reported as delivered");
			assert.include(textOf(refused), "tuval/claude/PortRefused");
			assert.include(textOf(refused), prompt.kind);
		}),
	);

	it.effect("takes a prompt carrying both the key and the timestamp", () =>
		Effect.gen(function* () {
			const {tools} = yield* server(agentTable);
			const sent = yield* answered(() =>
				tools.handlers.send({
					process: agentProcess,
					port: aiAgentPortNames.prompt,
					payload: {text: "hi", key: "child-1", timestamp: 1_700_000_000_000},
				}),
			);
			assert.isNotTrue(sent.isError);
			assert.deepStrictEqual(JSON.parse(textOf(sent)), {delivered: true, evicted: 0});
		}),
	);
});

/**
 * The three two-way ports, from the seat that used to read `delivered: true` on a payload the
 * process then refused where nothing reported it (#8235). Each in-port now admits one direction,
 * so the wrong one is an error the model reads at the send.
 */
const wrongWay = [
	{
		port: aiAgentPortNames.pageRequest,
		kind: transcriptPage.kind,
		wrong: {kind: "page", items: [], omitted: {items: 0, bytes: 0, reason: "none"}, next: null},
		right: {kind: "request", before: null, limit: 20},
	},
	{
		port: aiAgentPortNames.permissionDecision,
		kind: permission.kind,
		wrong: {kind: "pending", requests: {}},
		right: {kind: "decision", request: "req-1", decision: "allow-once"},
	},
	{
		port: aiAgentPortNames.modeSet,
		kind: mode.kind,
		wrong: {kind: "state", current: null, available: []},
		right: {kind: "set", mode: "plan"},
	},
];

describe("send, on the AI agent's two-way in-ports", () => {
	it.effect.each(wrongWay)("refuses a wrong-direction payload on $port at the send", (each) =>
		Effect.gen(function* () {
			const {tools} = yield* server(agentTable);
			const refused = yield* answered(() =>
				tools.handlers.send({process: agentProcess, port: each.port, payload: each.wrong}),
			);
			assert.isTrue(refused.isError, `a wrong-direction ${each.port} payload read as delivered`);
			assert.include(textOf(refused), "tuval/claude/PortRefused");
			assert.include(textOf(refused), each.kind);
		}),
	);

	it.effect.each(wrongWay)("takes the direction $port is the end for", (each) =>
		Effect.gen(function* () {
			const {tools} = yield* server(agentTable);
			const sent = yield* answered(() =>
				tools.handlers.send({process: agentProcess, port: each.port, payload: each.right}),
			);
			assert.isNotTrue(sent.isError);
			assert.deepStrictEqual(JSON.parse(textOf(sent)), {delivered: true, evicted: 0});
		}),
	);
});
