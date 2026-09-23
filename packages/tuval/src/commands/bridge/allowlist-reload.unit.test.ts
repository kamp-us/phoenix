/**
 * The allowlist across a config reload (#7743): the bridge is built once and the registry moves
 * under it, so what `call` allows has to be read at the call and not held from layer build.
 *
 * Both directions reload through the real `SpellSet`, which is the only way the proof is about the
 * bridge: rebuilding the layer would pass whatever the layer captured.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Schema} from "effect";
import {SpellExecutor} from "../executor.ts";
import {type Client, WindowIndex, type WindowPlacement} from "../scope.ts";
import {ClientId, defineSpell, type Scope, WindowId, WorkspaceId} from "../spell.ts";
import {SpellSet, type SpellSetInput} from "../spell-set.ts";
import {SpellNotAllowed} from "./errors.ts";
import {everyRegistered, SpellBridge} from "./SpellBridge.ts";

const workspace = WorkspaceId.make("ws-1");
const agentWindow = WindowId.make("w-1");
const client: Client = {id: ClientId.make("agent"), workspace};
const scope: Scope = {window: agentWindow, workspace, client: client.id};

const placements: Readonly<Record<string, WindowPlacement>> = {
	[agentWindow]: {workspace},
};

/** How many times the reloaded spell ran — the only way to prove a refusal did not execute it. */
const runs = {reloaded: 0};

const baseSpell = defineSpell({
	path: ["window", "close"],
	describe: "Close the named window.",
	params: Schema.Struct({}),
	result: Schema.Boolean,
	execute: () => Effect.succeed(true),
	capabilities: [],
});

const reloadedSpell = defineSpell({
	path: ["workspace", "wipe"],
	describe: "Delete the workspace.",
	params: Schema.Struct({}),
	result: Schema.Boolean,
	execute: () =>
		Effect.sync(() => {
			runs.reloaded++;
			return true;
		}),
	capabilities: [],
});

const withSpells = (core: SpellSetInput["core"]) =>
	SpellBridge.layer({allow: everyRegistered}).pipe(
		Layer.provideMerge(SpellExecutor.layer),
		Layer.provideMerge(
			Layer.mergeAll(
				SpellSet.layer({core, programs: [], keys: []}),
				WindowIndex.scripted(placements),
			),
		),
		Layer.orDie,
	);

describe("SpellBridge allowlist over a reload", () => {
	it.effect("a spell the reloaded config adds reaches the executor", () =>
		Effect.gen(function* () {
			runs.reloaded = 0;
			const bridge = yield* SpellBridge;
			const set = yield* SpellSet;
			const before = yield* Effect.flip(bridge.call(reloadedSpell.path, {}, scope));
			assert.instanceOf(before, SpellNotAllowed);
			yield* set
				.reload({core: [baseSpell, reloadedSpell], programs: [], keys: []})
				.pipe(Effect.orDie);
			assert.strictEqual(yield* bridge.call(reloadedSpell.path, {}, scope), true);
			assert.strictEqual(runs.reloaded, 1);
		}).pipe(Effect.provide(withSpells([baseSpell]))),
	);

	it.effect("a spell the reloaded config removes is refused at the gate, not by the registry", () =>
		Effect.gen(function* () {
			runs.reloaded = 0;
			const bridge = yield* SpellBridge;
			const set = yield* SpellSet;
			assert.strictEqual(yield* bridge.call(reloadedSpell.path, {}, scope), true);
			yield* set.reload({core: [baseSpell], programs: [], keys: []}).pipe(Effect.orDie);
			const refused = yield* Effect.flip(bridge.call(reloadedSpell.path, {}, scope));
			assert.instanceOf(refused, SpellNotAllowed);
			assert.include((refused as SpellNotAllowed).message, "workspace.wipe");
			assert.strictEqual(runs.reloaded, 1);
		}).pipe(Effect.provide(withSpells([baseSpell, reloadedSpell]))),
	);

	it.effect("what the bridge lists is what it allows, on both sides of a reload", () =>
		Effect.gen(function* () {
			const bridge = yield* SpellBridge;
			const set = yield* SpellSet;
			assert.deepStrictEqual(
				(yield* bridge.list).map((row) => row.path),
				[["window", "close"]],
			);
			yield* set
				.reload({core: [baseSpell, reloadedSpell], programs: [], keys: []})
				.pipe(Effect.orDie);
			assert.deepStrictEqual(
				(yield* bridge.list).map((row) => row.path),
				[
					["window", "close"],
					["workspace", "wipe"],
				],
			);
		}).pipe(Effect.provide(withSpells([baseSpell]))),
	);
});
