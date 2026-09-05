import {Effect, Layer, Schema} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import {ProcessId} from "../process/process.ts";
import {CallId} from "../protocol/ids.ts";
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
	readonly path: ReadonlyArray<string>;
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

const execute = (one: SpellCall): Promise<SpellReply> => {
	seen = undefined;
	return Effect.runPromise(
		Effect.flatMap(SpellExecutor, (executor) => executor.execute(one, client)).pipe(
			Effect.provide(layer),
		),
	);
};

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

	it("takes the process and workspace from the index when the call names a window", async () => {
		const reply = await execute(
			call({path: ["window", "close"], args: {id: "w-1"}, window: leftWindow}),
		);
		expect(reply.ok).toBe(true);
		expect(reply.ok ? reply.result : undefined).toEqual({closed: true});
		expect(seen).toEqual({
			window: leftWindow,
			process: counterProcess,
			workspace: otherWorkspace,
			client: client.id,
		});
	});

	it("runs a windowless call in the client's workspace, naming no process", async () => {
		await execute(call({path: ["window", "close"], args: {id: "w-1"}}));
		expect(seen).toEqual({workspace, client: client.id});
	});

	it("never reads the scope off the call's args — a forged process is ignored", async () => {
		await execute(
			call({
				path: ["window", "close"],
				args: {id: "w-1", process: forgedProcess},
				window: leftWindow,
			}),
		);
		expect(seen?.process).toBe(counterProcess);
	});

	it("refuses a window the index does not hold", async () => {
		const reply = await execute(
			call({path: ["window", "close"], args: {id: "w-1"}, window: missingWindow}),
		);
		expect(failure(reply)).toEqual({
			tag: "tuval/commands/NoSuchWindow",
			message: 'no window "w-9" is open',
			path: ["window", "close"],
		});
		expect(seen).toBeUndefined();
	});

	it("refuses an unknown path, naming the nearest one it holds", async () => {
		const reply = await execute(call({path: ["window", "clos"], args: {id: "w-1"}}));
		const error = failure(reply);
		expect(error.tag).toBe("tuval/commands/UnknownSpell");
		expect(error.didYouMean).toBe("window.close");
		expect(error.path).toEqual(["window", "clos"]);
	});

	it("refuses args the spell's params refuse, naming the argument and the expectation", async () => {
		const reply = await execute(call({path: ["window", "close"], args: {id: 3}}));
		const error = failure(reply);
		expect(error.tag).toBe("tuval/commands/BadArgs");
		expect(error.expected).toMatch(/string/i);
		expect(error.message).toContain('"id"');
		expect(error.message).toContain('"window.close"');
	});

	it("carries a spell's own tagged error through as the refusal's tag", async () => {
		const reply = await execute(call({path: ["window", "explode"], args: {}}));
		expect(failure(reply)).toEqual({
			tag: "test/Refused",
			message: "refused: the window is pinned",
			path: ["window", "explode"],
		});
	});

	it("names SpellFailed when a spell fails with a bare string, and quotes the string", async () => {
		const reply = await execute(call({path: ["window", "swear"], args: {}}));
		expect(failure(reply)).toEqual({
			tag: "tuval/commands/SpellFailed",
			message: 'spell "window.swear" failed with "the compositor said no"',
			path: ["window", "swear"],
		});
	});

	it("names SpellFailed when a spell fails with an untagged record, and renders it", async () => {
		const error = failure(await execute(call({path: ["window", "mutter"], args: {}})));
		expect(error.tag).toBe("tuval/commands/SpellFailed");
		expect(error.message).toContain("the disk is full");
		expect(error.message).not.toBe(`the call failed with ${error.tag}`);
	});

	it("keeps the untagged value on the error rather than dropping it", () => {
		const original = {reason: "the disk is full"};
		const failed = new SpellFailed({path: "window.mutter", original});
		expect(failed.original).toBe(original);
		expect(failed._tag).toBe("tuval/commands/SpellFailed");
	});

	it("falls back to the tag only when a named error carries no message", async () => {
		const reply = await execute(call({path: ["window", "hush"], args: {}}));
		expect(failure(reply).message).toBe("the call failed with test/Silent");
	});

	it("dies rather than replies when a spell's value its own result schema refuses", async () => {
		await expect(execute(call({path: ["window", "lie"], args: {}}))).rejects.toThrow(
			/result its own schema refuses/,
		);
	});
});
