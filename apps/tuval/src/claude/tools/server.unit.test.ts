/**
 * The tool server over the scripted bridge: what the model is offered, and what one call answers.
 * Nothing here reaches a kernel — `KernelBridge.scripted` is the whole world, which is what makes
 * every assertion below deterministic.
 *
 * These are plain async tests rather than `it.effect` ones: a tool handler is a `Promise`, which is
 * the whole point of the seam, and awaiting one inside an Effect would mean `Effect.promise`, which
 * this repo bans.
 */

import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import {Effect} from "effect";
import {assert, describe, it} from "vitest";
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

/** The per-process runtime, plus a count, so a handler that ran its Effect elsewhere is visible. */
const countingRuntime = (): ToolRuntime & {readonly runs: () => number} => {
	let runs = 0;
	return {
		runPromise: (effect) => {
			runs++;
			return Effect.runPromise(effect);
		},
		runs: () => runs,
	};
};

const server = () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const bridge = yield* KernelBridge;
			const run = countingRuntime();
			return {tools: tuvalToolServer(bridge, run), run};
		}).pipe(Effect.provide(KernelBridge.scripted(table))),
	);

const textOf = (result: CallToolResult): string => {
	const first = result.content[0];
	assert.strictEqual(first?.type, "text", "a tool answered with something other than text");
	return first?.type === "text" ? first.text : "";
};

describe("the tuval tool server", () => {
	it("registers exactly the three tools, on the tuval server, at their wire names", async () => {
		const {tools} = await server();
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
	});

	it("every handler runs its Effect through the runtime it was given", async () => {
		const {tools, run} = await server();
		await tools.handlers.spawn({program: scriptedProgram});
		await tools.handlers.send({process: scriptedProcess, port: "words", payload: "hi"});
		await tools.handlers.read({process: scriptedProcess, port: "echoed"});
		assert.strictEqual(run.runs(), 3, "a handler ran its Effect outside the supplied runtime");
	});

	it("each handler answers a CallToolResult carrying the bridge's own answer", async () => {
		const {tools} = await server();

		const spawned = await tools.handlers.spawn({program: scriptedProgram});
		assert.isNotTrue(spawned.isError);
		assert.deepStrictEqual(JSON.parse(textOf(spawned)), {process: scriptedProcess});

		const sent = await tools.handlers.send({
			process: scriptedProcess,
			port: "words",
			payload: "hi",
		});
		assert.isNotTrue(sent.isError);
		assert.deepStrictEqual(JSON.parse(textOf(sent)), {delivered: true});

		const held = await tools.handlers.read({process: scriptedProcess, port: "echoed"});
		assert.isNotTrue(held.isError);
		assert.deepStrictEqual(JSON.parse(textOf(held)), {empty: false, value: "HI"});
	});

	it("a bridge refusal is an isError result carrying the tag, never a throw", async () => {
		const {tools} = await server();

		const missing = await tools.handlers.spawn({program: "nothing-registered"});
		assert.isTrue(missing.isError);
		assert.include(textOf(missing), "tuval/claude/UnknownProgram");

		// A payload of the wrong kind: the tag and the kind the port takes both reach the model.
		const refused = await tools.handlers.send({
			process: scriptedProcess,
			port: "words",
			payload: 7,
		});
		assert.isTrue(refused.isError);
		assert.include(textOf(refused), "tuval/claude/PortRefused");
		assert.include(textOf(refused), WORD_KIND);

		const nowhere = await tools.handlers.read({process: scriptedProcess, port: "absent"});
		assert.isTrue(nowhere.isError);
		assert.include(textOf(nowhere), "tuval/claude/UnknownPort");
	});

	// The test's own timeout is the assertion: a `read` that waited on an empty port would run out
	// of it rather than answering.
	it("read on a port that has said nothing answers empty rather than waiting", {
		timeout: 1000,
	}, async () => {
		const {tools} = await server();
		const held = await tools.handlers.read({process: scriptedProcess, port: "quiet"});
		assert.isNotTrue(held.isError);
		assert.deepStrictEqual(JSON.parse(textOf(held)), {empty: true});
	});

	it("the scripted bridge takes whatever program id it is handed", async () => {
		const spawned = await Effect.runPromise(
			Effect.gen(function* () {
				const bridge = yield* KernelBridge;
				return yield* bridge.spawn(ProgramId.make(scriptedProgram));
			}).pipe(Effect.provide(KernelBridge.scripted(table))),
		);
		assert.strictEqual(spawned, scriptedProcess);
	});
});
