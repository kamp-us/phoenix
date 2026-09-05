/**
 * The rows as the registry holds them. The claim under test is that the shell adds no second
 * command mechanism: every row registers as an ordinary spell, describes without throwing, and runs
 * by dispatching exactly the Msg the row would have produced on its own.
 */

import {assert, describe, expect, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {SpellExecutor} from "../../commands/executor.ts";
import {buildRegistry, SpellRegistry} from "../../commands/registry.ts";
import {type Client, WindowIndex} from "../../commands/scope.ts";
import {ClientId, WorkspaceId} from "../../commands/spell.ts";
import {CallId, type SpellPath} from "../../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellCall, type SpellReply} from "../../protocol/messages.ts";
import type {ShellMsg} from "../core/machine.ts";
import {ShellDispatch} from "./dispatch.ts";
import {commandName} from "./row.ts";
import {shellSpells} from "./spells.ts";
import {shellCommands} from "./table.ts";

const client: Client = {id: ClientId.make("cli"), workspace: WorkspaceId.make("ws-1")};

const call = (path: SpellPath, args: unknown): SpellCall =>
	new SpellCall({
		type: "spell.call",
		version: PROTOCOL_VERSION,
		id: CallId.make("c-1"),
		path,
		args,
	});

const executorLayer = SpellExecutor.layer.pipe(
	Layer.provide(Layer.mergeAll(SpellRegistry.scripted(shellSpells), WindowIndex.scripted({}))),
);

/** The executor beside the dispatcher a run collects into — one merged provide, one lifecycle. */
const layerFor = (dispatched: Array<ShellMsg>) =>
	Layer.mergeAll(executorLayer, ShellDispatch.scripted(dispatched));

/** Run one call against the shell's spells alone, collecting whatever it dispatched. */
const run = (path: SpellPath, args: unknown) =>
	Effect.suspend(() => {
		const dispatched: Array<ShellMsg> = [];
		return Effect.flatMap(SpellExecutor, (executor) =>
			executor.execute(call(path, args), client),
		).pipe(
			Effect.provide(layerFor(dispatched)),
			Effect.map((reply) => ({reply, dispatched: dispatched as ReadonlyArray<ShellMsg>})),
		);
	});

const failure = (reply: SpellReply) => {
	if (reply.ok) throw new Error(`expected a refusal, got ${JSON.stringify(reply)}`);
	return reply.error;
};

describe("the shell's rows as spells", () => {
	it("declares one spell per row, at the row's own path and with the row's sentence", () => {
		expect(shellSpells.map((spell) => spell.path)).toEqual(
			shellCommands.map((command) => command.path),
		);
		expect(shellSpells.map((spell) => spell.describe)).toEqual(
			shellCommands.map((command) => command.describe),
		);
	});

	it.effect("registers, and every one describes without throwing", () =>
		Effect.gen(function* () {
			const table = yield* buildRegistry({core: shellSpells, programs: []});
			assert.deepStrictEqual(
				table.rows.map((row) => row.path.join(":")),
				shellCommands.map((command) => String(commandName(command.path))),
			);
			for (const row of table.rows) {
				assert.strictEqual(
					`${row.path.join(":")}: ${typeof row.paramsDocument}`,
					`${row.path.join(":")}: object`,
				);
			}
		}),
	);
});

describe("running a row's spell", () => {
	it.effect("dispatches exactly the Msg the row builds, and answers with its type", () =>
		Effect.gen(function* () {
			const {reply, dispatched} = yield* run(["workspace", "activate"], {workspace: "ws-2"});
			assert.deepStrictEqual(dispatched, [{type: "workspace.activate", workspaceId: "ws-2"}]);
			assert.deepStrictEqual(reply.ok ? reply.result : failure(reply), {
				msg: "workspace.activate",
			});
		}),
	);

	it.effect("refuses arguments the row's own schema refuses, without dispatching", () =>
		Effect.gen(function* () {
			const {reply, dispatched} = yield* run(["workspace", "activate"], {workspace: ""});
			assert.deepStrictEqual(dispatched, []);
			assert.strictEqual(failure(reply).tag, "tuval/commands/BadArgs");
		}),
	);

	it.effect("refuses a path no row carries", () =>
		Effect.gen(function* () {
			const {reply, dispatched} = yield* run(["window", "quit"], {});
			assert.deepStrictEqual(dispatched, []);
			assert.strictEqual(failure(reply).tag, "tuval/commands/UnknownSpell");
		}),
	);
});
