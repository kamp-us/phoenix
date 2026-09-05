import {assert, describe, expect, expectTypeOf, it} from "@effect/vitest";
import {Cause, Effect, Exit, Layer, Schema} from "effect";
import {ProcessId} from "../process/process.ts";
import {CallId, type SpellPath} from "../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellCall, type SpellReply} from "../protocol/messages.ts";
import {SpellFailed} from "./errors.ts";
import {SpellExecutor} from "./executor.ts";
import {SpellRegistry} from "./registry.ts";
import {type Client, WindowIndex, type WindowPlacement} from "./scope.ts";
import {type AnySpell, ClientId, defineSpell, type Scope, WindowId, WorkspaceId} from "./spell.ts";

class Refused extends Schema.TaggedError<Refused>()("test/Refused", {why: Schema.String}) {
	override get message(): string {
		return `refused: ${this.why}`;
	}
}

const workspace = WorkspaceId.make("ws-1");
const otherWorkspace = WorkspaceId.make("ws-2");
const leftWindow = WindowId.make("w-1");
const missingWindow = WindowId.make("w-9");
const counterProcess = ProcessId.make("p-1");
const forgedProcess = ProcessId.make("p-forged");

const client: Client = {id: ClientId.make("cli"), workspace};

const placements: Readonly<Record<string, WindowPlacement>> = {
	[leftWindow]: {process: counterProcess, workspace: otherWorkspace},
};

/** The scope the last `close` call ran under — how a test reads what the kernel handed the spell. */
let seen: Scope | undefined;

const close = defineSpell({
	path: ["window", "close"],
	describe: "Close the named window.",
	params: Schema.Struct({id: Schema.String, process: Schema.optionalKey(Schema.String)}),
	result: Schema.Struct({closed: Schema.Boolean}),
	execute: (args, scope) =>
		Effect.sync(() => {
			seen = scope;
			return {closed: args.id.length > 0};
		}),
	capabilities: [],
});

const refuse = defineSpell({
	path: ["window", "explode"],
	describe: "Fail on purpose.",
	params: Schema.Struct({}),
	result: Schema.Boolean,
	execute: () => Effect.fail(new Refused({why: "the window is pinned"})),
	capabilities: [],
});

const swear = defineSpell({
	path: ["window", "swear"],
	describe: "Fail with a bare string.",
	params: Schema.Struct({}),
	result: Schema.Boolean,
	execute: () => Effect.fail("the compositor said no"),
	capabilities: [],
});

const mutter = defineSpell({
	path: ["window", "mutter"],
	describe: "Fail with a record carrying no tag.",
	params: Schema.Struct({}),
	result: Schema.Boolean,
	execute: () => Effect.fail({reason: "the disk is full"}),
	capabilities: [],
});

const hush = defineSpell({
	path: ["window", "hush"],
	describe: "Fail with a tag and no message.",
	params: Schema.Struct({}),
	result: Schema.Boolean,
	execute: () => Effect.fail({_tag: "test/Silent"}),
	capabilities: [],
});

// Written as an erased `AnySpell` rather than through `defineSpell`, which is exactly the compile
// error this spell exists to get past: a spell whose value its own `result` refuses.
const lie: AnySpell = {
	path: ["window", "lie"],
	describe: "Return a value its own result schema refuses.",
	params: Schema.Struct({}),
	result: Schema.Struct({closed: Schema.Boolean}),
	execute: () => Effect.succeed({closed: "not a boolean"}),
	capabilities: [],
};

const spells: ReadonlyArray<AnySpell> = [close, refuse, swear, mutter, hush, lie];

const layer = SpellExecutor.layer.pipe(
	Layer.provide(Layer.mergeAll(SpellRegistry.scripted(spells), WindowIndex.scripted(placements))),
);

const call = (fields: {
	readonly path: SpellPath;
	readonly args: unknown;
	readonly window?: WindowId;
}): SpellCall =>
	new SpellCall({
		type: "spell.call",
		version: PROTOCOL_VERSION,
		id: CallId.make("c-1"),
		path: fields.path,
		args: fields.args,
		...(fields.window === undefined ? {} : {window: fields.window}),
	});

const execute = (one: SpellCall) =>
	Effect.suspend(() => {
		seen = undefined;
		return Effect.flatMap(SpellExecutor, (executor) => executor.execute(one, client)).pipe(
			Effect.provide(layer),
		);
	});

const failure = (reply: SpellReply) => {
	if (reply.ok) throw new Error(`expected a refusal, got ${JSON.stringify(reply)}`);
	return reply.error;
};

describe("SpellExecutor", () => {
	it("answers with a reply and nothing else — its error channel is `never`", () => {
		expectTypeOf<SpellExecutor["Service"]["execute"]>().returns.toEqualTypeOf<
			Effect.Effect<SpellReply, never, never>
		>();
	});

	it.effect("takes the process and workspace from the index when the call names a window", () =>
		Effect.gen(function* () {
			const reply = yield* execute(
				call({path: ["window", "close"], args: {id: "w-1"}, window: leftWindow}),
			);
			assert.strictEqual(reply.ok, true);
			assert.deepStrictEqual(reply.ok ? reply.result : undefined, {closed: true});
			assert.deepStrictEqual(seen, {
				window: leftWindow,
				process: counterProcess,
				workspace: otherWorkspace,
				client: client.id,
			});
		}),
	);

	it.effect("runs a windowless call in the client's workspace, naming no process", () =>
		Effect.gen(function* () {
			yield* execute(call({path: ["window", "close"], args: {id: "w-1"}}));
			assert.deepStrictEqual(seen, {workspace, client: client.id});
		}),
	);

	it.effect("never reads the scope off the call's args — a forged process is ignored", () =>
		Effect.gen(function* () {
			yield* execute(
				call({
					path: ["window", "close"],
					args: {id: "w-1", process: forgedProcess},
					window: leftWindow,
				}),
			);
			assert.strictEqual(seen?.process, counterProcess);
		}),
	);

	it.effect("refuses a window the index does not hold", () =>
		Effect.gen(function* () {
			const reply = yield* execute(
				call({path: ["window", "close"], args: {id: "w-1"}, window: missingWindow}),
			);
			assert.deepStrictEqual(failure(reply), {
				tag: "tuval/commands/NoSuchWindow",
				message: 'no window "w-9" is open',
				path: ["window", "close"],
			});
			assert.strictEqual(seen, undefined);
		}),
	);

	it.effect("refuses an unknown path, naming the nearest one it holds", () =>
		Effect.gen(function* () {
			const reply = yield* execute(call({path: ["window", "clos"], args: {id: "w-1"}}));
			const error = failure(reply);
			assert.strictEqual(error.tag, "tuval/commands/UnknownSpell");
			assert.strictEqual(error.didYouMean, "window.close");
			assert.deepStrictEqual(error.path, ["window", "clos"]);
		}),
	);

	it.effect("refuses args the spell's params refuse, naming the argument and the expectation", () =>
		Effect.gen(function* () {
			const reply = yield* execute(call({path: ["window", "close"], args: {id: 3}}));
			const error = failure(reply);
			assert.strictEqual(error.tag, "tuval/commands/BadArgs");
			assert.match(error.expected ?? "", /string/i);
			assert.include(error.message, '"id"');
			assert.include(error.message, '"window.close"');
		}),
	);

	it.effect("carries a spell's own tagged error through as the refusal's tag", () =>
		Effect.gen(function* () {
			const reply = yield* execute(call({path: ["window", "explode"], args: {}}));
			assert.deepStrictEqual(failure(reply), {
				tag: "test/Refused",
				message: "refused: the window is pinned",
				path: ["window", "explode"],
			});
		}),
	);

	it.effect("names SpellFailed when a spell fails with a bare string, and quotes the string", () =>
		Effect.gen(function* () {
			const reply = yield* execute(call({path: ["window", "swear"], args: {}}));
			assert.deepStrictEqual(failure(reply), {
				tag: "tuval/commands/SpellFailed",
				message: 'spell "window.swear" failed with "the compositor said no"',
				path: ["window", "swear"],
			});
		}),
	);

	it.effect("names SpellFailed when a spell fails with an untagged record, and renders it", () =>
		Effect.gen(function* () {
			const error = failure(yield* execute(call({path: ["window", "mutter"], args: {}})));
			assert.strictEqual(error.tag, "tuval/commands/SpellFailed");
			assert.include(error.message, "the disk is full");
			assert.notStrictEqual(error.message, `the call failed with ${error.tag}`);
		}),
	);

	it("keeps the untagged value on the error rather than dropping it", () => {
		const original = {reason: "the disk is full"};
		const failed = new SpellFailed({path: "window.mutter", original});
		expect(failed.original).toBe(original);
		expect(failed._tag).toBe("tuval/commands/SpellFailed");
	});

	it.effect("falls back to the tag only when a named error carries no message", () =>
		Effect.gen(function* () {
			const reply = yield* execute(call({path: ["window", "hush"], args: {}}));
			assert.strictEqual(failure(reply).message, "the call failed with test/Silent");
		}),
	);

	it.effect("dies rather than replies when a spell's value its own result schema refuses", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(execute(call({path: ["window", "lie"], args: {}})));
			assert.strictEqual(Exit.isFailure(exit), true);
			assert.match(
				Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "",
				/result its own schema refuses/,
			);
		}),
	);
});
