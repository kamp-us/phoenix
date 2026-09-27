/**
 * The wire, end to end: a scripted page speaks JSON to the executor and reads JSON back (#7645).
 *
 * The four messages and the codec have their own tests (`protocol/protocol.unit.test.ts`); what is
 * proved here is the round trip they only make together — a call encoded by a page, decoded by the
 * kernel, answered, encoded back and decoded by the page, with the registry riding in a `Snapshot`
 * and a `Patch` carrying what a mutation changed.
 */

import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Ref, Schema} from "effect";
import {
	decodeKernelMessage,
	decodePageMessage,
	encodeKernelMessage,
	encodePageMessage,
} from "../protocol/codec.ts";
import {counterRow, workspace as deskWorkspace, leftWindow} from "../protocol/fixtures.ts";
import {CallId, Revision} from "../protocol/ids.ts";
import {
	isSpellReply,
	Patch,
	PROTOCOL_VERSION,
	Snapshot,
	SpellCall,
	type SpellReply,
} from "../protocol/messages.ts";
import {applyPatch} from "../protocol/patch.ts";
import type {RegistryDescription} from "../protocol/registry-description.ts";
import {SpellExecutor} from "./executor.ts";
import {SpellRegistry} from "./registry.ts";
import {type Client, WindowIndex} from "./scope.ts";
import {ClientId, defineSpell, type SpellPath, WorkspaceId} from "./spell.ts";

const client: Client = {id: ClientId.make("page"), workspace: WorkspaceId.make("ws-1")};

const resultOf = (reply: SpellReply): unknown => {
	assert.isTrue(reply.ok, `expected a successful reply, got ${JSON.stringify(reply)}`);
	return reply.ok ? reply.result : undefined;
};

/** The desk at one count: the protocol fixtures' own, with the workspace name that count implies. */
const snapshotOf = (rev: number, registry: RegistryDescription, count: number): Snapshot =>
	new Snapshot({
		type: "snapshot",
		version: PROTOCOL_VERSION,
		rev: Revision.make(rev),
		desk: {
			workspaces: {
				[deskWorkspace]: {
					id: deskWorkspace,
					name: `count ${count}`,
					layout: {kind: "leaf", window: leftWindow},
					focused: leftWindow,
				},
			},
			activeWorkspace: deskWorkspace,
		},
		windows: {[leftWindow]: {id: leftWindow, recency: 1}},
		processes: [counterRow],
		registry,
	});

/**
 * The kernel's state behind the two count spells: the count, the desk whose workspace name it
 * names, and the patches its mutations emitted.
 *
 * `bump` writes all three in one step, which is what lets the `Patch` leg below assert over the
 * patch the mutation produced. A patch the test writes proves only that `applyPatch` applies a
 * patch: a kernel emitting the wrong change, or none, passes it unchanged.
 */
class Counter extends Context.Service<
	Counter,
	{
		readonly read: Effect.Effect<number>;
		readonly bump: Effect.Effect<number>;
		/** The desk as the kernel holds it now — what a page that applied every patch must match. */
		readonly desk: Effect.Effect<Snapshot>;
		readonly emitted: Effect.Effect<ReadonlyArray<Patch>>;
	}
>()("tuval/wireProof/Counter") {
	static readonly layer: Layer.Layer<Counter, never, SpellRegistry> = Layer.effect(
		Counter,
		Effect.gen(function* () {
			const registry = yield* SpellRegistry.use((held) => held.describe);
			const desk = yield* Ref.make(snapshotOf(1, registry, 0));
			const patches = yield* Ref.make<ReadonlyArray<Patch>>([]);
			const count = yield* Ref.make(0);
			return Counter.of({
				read: Ref.get(count),
				desk: Ref.get(desk),
				emitted: Ref.get(patches),
				bump: Effect.gen(function* () {
					const next = yield* Ref.updateAndGet(count, (held) => held + 1);
					const current = yield* Ref.get(desk);
					const patch = new Patch({
						type: "patch",
						version: PROTOCOL_VERSION,
						rev: Revision.make(current.rev + 1),
						changes: [
							{
								op: "replace",
								path: ["desk", "workspaces", deskWorkspace, "name"],
								value: `count ${next}`,
							},
						],
					});
					yield* Ref.set(desk, snapshotOf(patch.rev, registry, next));
					yield* Ref.update(patches, (held) => [...held, patch]);
					return next;
				}),
			});
		}),
	);
}

const readCount = defineSpell({
	path: ["count", "read"],
	describe: "Answer the current count.",
	params: Schema.Struct({}),
	result: Schema.Struct({count: Schema.Number}),
	execute: () =>
		Effect.map(
			Effect.flatMap(Counter, (counter) => counter.read),
			(count) => ({count}),
		),
	capabilities: [],
});

const bumpCount = defineSpell({
	path: ["count", "bump"],
	describe: "Add one to the count.",
	params: Schema.Struct({}),
	result: Schema.Struct({count: Schema.Number}),
	execute: () =>
		Effect.map(
			Effect.flatMap(Counter, (counter) => counter.bump),
			(count) => ({count}),
		),
	capabilities: [],
});

const app = Layer.mergeAll(SpellExecutor.layer, Counter.layer).pipe(
	Layer.provideMerge(
		Layer.mergeAll(SpellRegistry.scripted([readCount, bumpCount]), WindowIndex.scripted({})),
	),
	Layer.orDie,
);

/** One exchange as a page makes it: JSON out, JSON back, nothing shared but the text. */
const exchange = Effect.fn("wireProof.exchange")(function* (
	id: string,
	path: SpellPath,
	args: unknown,
) {
	const callId = CallId.make(id);
	const request = yield* encodePageMessage(
		new SpellCall({type: "spell.call", version: PROTOCOL_VERSION, id: callId, path, args}),
	).pipe(Effect.orDie);
	const call = yield* decodePageMessage(request).pipe(Effect.orDie);
	const executor = yield* SpellExecutor;
	const reply = yield* executor.execute(call, client);
	const response = yield* encodeKernelMessage(reply).pipe(Effect.orDie);
	const back = yield* decodeKernelMessage(response).pipe(Effect.orDie);
	assert.isTrue(isSpellReply(back), "the kernel answered a call with something else");
	return {callId, reply: back as SpellReply};
});

describe("the wire", () => {
	it.effect("answers one reply per call, each carrying that call's own id", () =>
		Effect.gen(function* () {
			const first = yield* exchange("c-1", ["count", "read"], {});
			const second = yield* exchange("c-2", ["count", "bump"], {});

			assert.strictEqual(first.reply.id, first.callId, "a reply carried another call's id");
			assert.strictEqual(second.reply.id, second.callId, "a reply carried another call's id");
			assert.deepStrictEqual(resultOf(first.reply), {count: 0});
			assert.deepStrictEqual(resultOf(second.reply), {count: 1});
		}).pipe(Effect.provide(app)),
	);

	it.effect("carries the registry in a Snapshot, over the same codec", () =>
		Effect.gen(function* () {
			const registry = yield* SpellRegistry.use((held) => held.describe);
			const sent = yield* encodeKernelMessage(snapshotOf(1, registry, 0)).pipe(Effect.orDie);
			const back = yield* decodeKernelMessage(sent).pipe(Effect.orDie);

			assert.instanceOf(back, Snapshot);
			const carried = (back as Snapshot).registry;
			assert.deepStrictEqual(
				carried.map((description) => description.path.join(".")),
				["count.read", "count.bump"],
				"the snapshot did not carry the registry the kernel holds",
			);
			assert.isDefined(carried[0]?.params, "a description reached the page without its params");
		}).pipe(Effect.provide(app)),
	);

	it.effect("delivers what a mutation changed as a Patch the page applies over its snapshot", () =>
		Effect.gen(function* () {
			const counter = yield* Counter;
			const before = yield* counter.desk;
			assert.deepStrictEqual(yield* counter.emitted, [], "a patch was emitted before any call");

			yield* exchange("c-4", ["count", "read"], {});
			assert.deepStrictEqual(
				yield* counter.emitted,
				[],
				"a read emitted a patch, so a patch is not what a mutation changed",
			);

			const {reply} = yield* exchange("c-3", ["count", "bump"], {});
			assert.deepStrictEqual(resultOf(reply), {count: 1});

			const emitted = yield* counter.emitted;
			assert.strictEqual(emitted.length, 1, "the mutation did not emit exactly one patch");
			const [produced] = emitted;
			assert.isDefined(produced, "the mutation emitted no patch");
			if (produced === undefined) return;

			const sent = yield* encodeKernelMessage(produced).pipe(Effect.orDie);
			const delivered = yield* decodeKernelMessage(sent).pipe(Effect.orDie);
			assert.instanceOf(delivered, Patch);

			const after = yield* applyPatch(before, delivered as Patch);
			// The page's rebuilt desk against the kernel's own: a patch that carried less than the
			// mutation changed leaves the two disagreeing, which no assertion over the patch's own
			// text would show.
			assert.deepStrictEqual(
				after,
				yield* counter.desk,
				"the page that applied the patch is not holding the desk the kernel holds",
			);
			assert.strictEqual(after.desk.workspaces[deskWorkspace]?.name, "count 1");
			assert.strictEqual(
				before.desk.workspaces[deskWorkspace]?.name,
				"count 0",
				"applying a patch rewrote the snapshot it was applied over",
			);
		}).pipe(Effect.provide(app)),
	);

	it.effect("refuses an undecodable message and says why, rather than half-reading it", () =>
		Effect.gen(function* () {
			const notJson = yield* Effect.flip(decodePageMessage("{"));
			assert.strictEqual(notJson.direction, "page-to-kernel");
			assert.include(notJson.reason, "not JSON");

			const missingPath = yield* Effect.flip(
				decodePageMessage(JSON.stringify({type: "spell.call", version: 1, id: "c-1"})),
			);
			assert.include(missingPath.message, "page-to-kernel");
			assert.isTrue(missingPath.reason.length > 0, "a refusal arrived with no reason");

			const otherBuild = yield* Effect.flip(
				decodePageMessage(
					JSON.stringify({
						type: "spell.call",
						version: PROTOCOL_VERSION + 1,
						id: "c-1",
						path: ["count", "read"],
						args: {},
					}),
				),
			);
			assert.isTrue(
				otherBuild.reason.length > 0,
				"a message from another build was admitted without a reason",
			);
		}),
	);
});
