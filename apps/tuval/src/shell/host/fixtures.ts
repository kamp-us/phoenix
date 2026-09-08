/**
 * A spell channel of the shape `./serve.ts` mints, over a scripted registry rather than a booted
 * kernel: two spells, one that answers and one that never does.
 *
 * It lives here and not beside the transport's own test because that directory keeps a boundary —
 * nothing under `../transport/` may name a client's scope, and its `boundary.unit.test.ts` scans
 * every file there for the words. Naming the caller is this layer's job, which is the same reason
 * the real channel is minted in `./serve.ts`.
 */

import {Context, Effect, Layer, Schema, Stream} from "effect";
import {SpellExecutor} from "../../commands/executor.ts";
import {buildRegistry, describeSpell, SpellRegistry} from "../../commands/registry.ts";
import {type Client, WindowIndex} from "../../commands/scope.ts";
import {ClientId, defineSpell, WorkspaceId} from "../../commands/spell.ts";
import type {SpellChannel} from "../transport/server.ts";

export const echoSpell = defineSpell({
	path: ["desk", "echo"],
	describe: "Echo one word back.",
	params: Schema.Struct({word: Schema.String}),
	result: Schema.Struct({word: Schema.String}),
	capabilities: [],
	execute: ({word}) => Effect.succeed({word}),
});

export const foreverSpell = defineSpell({
	path: ["desk", "forever"],
	describe: "Never answer.",
	params: Schema.Struct({}),
	result: Schema.Struct({}),
	capabilities: [],
	execute: () => Effect.never,
});

const scriptedClient: Client = {
	id: ClientId.make("page"),
	workspace: WorkspaceId.make("ws-1"),
};

/** The channel, over the real executor: a call a test makes travels the kernel's own path. */
export const scriptedSpellChannel = Effect.fn("Tuval.shell.scriptedSpellChannel")(function* () {
	const context = yield* Layer.build(
		SpellExecutor.layer.pipe(
			Layer.provideMerge(SpellRegistry.scripted([echoSpell, foreverSpell])),
			Layer.provideMerge(WindowIndex.scripted({})),
		),
	).pipe(Effect.orDie);
	const executor = Context.get(context, SpellExecutor);
	return Effect.sync(() => (call) => executor.execute(call, scriptedClient)) as SpellChannel;
});

export const scriptedDescriptions = Stream.fromEffect(
	Effect.map(buildRegistry({core: [echoSpell, foreverSpell], programs: []}), (table) =>
		table.rows.map(describeSpell),
	).pipe(Effect.orDie),
);
