import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Schema} from "effect";
import {SpellExecutor} from "../executor.ts";
import {SpellRegistry} from "../registry.ts";
import {type Client, WindowIndex, type WindowPlacement} from "../scope.ts";
import {type AnySpell, ClientId, defineSpell, type Scope, WindowId, WorkspaceId} from "../spell.ts";
import {SpellNotAllowed} from "./errors.ts";
import {SpellBridge} from "./SpellBridge.ts";

const workspace = WorkspaceId.make("ws-1");
const agentWindow = WindowId.make("w-1");
const client: Client = {id: ClientId.make("agent"), workspace};
const scope: Scope = {window: agentWindow, workspace, client: client.id};

const placements: Readonly<Record<string, WindowPlacement>> = {
	[agentWindow]: {workspace},
};

/** How many times each spell actually ran — the only way to prove a refusal did not execute one. */
const runs = {allowed: 0, forbidden: 0};

const allowedSpell = defineSpell({
	path: ["window", "close"],
	describe: "Close the named window.",
	params: Schema.Struct({id: Schema.String}),
	result: Schema.Struct({closed: Schema.Boolean}),
	execute: (args) =>
		Effect.sync(() => {
			runs.allowed++;
			return {closed: args.id.length > 0};
		}),
	capabilities: [],
});

const forbiddenSpell = defineSpell({
	path: ["workspace", "wipe"],
	describe: "Delete the workspace.",
	params: Schema.Struct({}),
	result: Schema.Boolean,
	execute: () =>
		Effect.sync(() => {
			runs.forbidden++;
			return true;
		}),
	capabilities: [],
});

const spells: ReadonlyArray<AnySpell> = [allowedSpell, forbiddenSpell];

const registry = SpellRegistry.scripted(spells);

const app = SpellBridge.layer({allow: [allowedSpell.path]}).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			SpellExecutor.layer.pipe(
				Layer.provide(Layer.mergeAll(registry, WindowIndex.scripted(placements))),
			),
			registry,
		),
	),
);

const withBridge = <A, E>(body: Effect.Effect<A, E, SpellBridge | SpellRegistry>) =>
	body.pipe(Effect.provide(app));

describe("SpellBridge", () => {
	it.effect("an allowed path runs the spell and answers its decoded result", () =>
		withBridge(
			Effect.gen(function* () {
				runs.allowed = 0;
				const bridge = yield* SpellBridge;
				const result = yield* bridge.call(allowedSpell.path, {id: "w-1"}, scope);
				assert.deepStrictEqual(result, {closed: true});
				assert.strictEqual(runs.allowed, 1);
			}),
		),
	);

	it.effect("a path outside the allowlist is refused and the spell is not executed", () =>
		withBridge(
			Effect.gen(function* () {
				runs.forbidden = 0;
				const bridge = yield* SpellBridge;
				const refused = yield* Effect.flip(bridge.call(forbiddenSpell.path, {}, scope));
				assert.instanceOf(refused, SpellNotAllowed);
				assert.include((refused as SpellNotAllowed).message, "workspace.wipe");
				assert.strictEqual(runs.forbidden, 0);
			}),
		),
	);

	it.effect("a spell's own failure crosses as the wire failure, not as a refusal", () =>
		withBridge(
			Effect.gen(function* () {
				const bridge = yield* SpellBridge;
				const failed = yield* Effect.flip(bridge.call(allowedSpell.path, {id: 7}, scope));
				assert.notInstanceOf(failed, SpellNotAllowed);
				assert.strictEqual((failed as {readonly tag: string}).tag, "tuval/commands/BadArgs");
			}),
		),
	);

	it.effect("list is the registry's own description, row for row", () =>
		withBridge(
			Effect.gen(function* () {
				const bridge = yield* SpellBridge;
				const registered = yield* SpellRegistry;
				assert.deepStrictEqual(yield* bridge.list, yield* registered.describe);
			}),
		),
	);

	it.effect(
		"the scripted bridge answers from its table and describes exactly what it answers",
		() =>
			Effect.gen(function* () {
				const bridge = yield* SpellBridge;
				assert.deepStrictEqual(
					(yield* bridge.list).map((row) => row.path),
					[["window", "close"]],
				);
				assert.deepStrictEqual(yield* bridge.call(allowedSpell.path, {id: "w-1"}, scope), {
					closed: true,
				});
				const missing = yield* Effect.flip(bridge.call(forbiddenSpell.path, {}, scope));
				assert.strictEqual((missing as {readonly tag: string}).tag, "tuval/commands/UnknownSpell");
			}).pipe(
				Effect.provide(SpellBridge.scripted([{spell: allowedSpell, answer: {closed: true}}])),
			),
	);
});
