import {Effect, Layer, Schema} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import {ProcessId} from "../process/process.ts";
import {CallId} from "../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellCall, type SpellReply} from "../protocol/messages.ts";
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

const spells: ReadonlyArray<AnySpell> = [close, refuse, lie];

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
	if (reply.outcome.ok) throw new Error(`expected a refusal, got ${JSON.stringify(reply.outcome)}`);
	return reply.outcome.error;
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
		expect(reply.outcome).toEqual({ok: true, result: {closed: true}});
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

	it("dies rather than replies when a spell's value its own result schema refuses", async () => {
		await expect(execute(call({path: ["window", "lie"], args: {}}))).rejects.toThrow(
			/result its own schema refuses/,
		);
	});
});
