/**
 * The shell's command rows, called against a real boot (#7774).
 *
 * Every row is registered as a spell whose `execute` needs `ShellDispatch`, and `AnySpell` erases
 * that requirement, so nothing but a running call can show the composition root actually pays it.
 * These are that call: `start` builds the kernel the app boots with, and each spell goes in through
 * `SpellExecutor.execute` or `SpellBridge.call` — the two doors a page and an agent use — with the
 * desk read afterwards to prove the Msg landed rather than merely being answered.
 *
 * The provider is load-bearing twice over. In the checker, `boot.ts`'s `Kernel` names
 * `ShellDispatch` and `Context` is contravariant in its services, so dropping the layer stops
 * `start` compiling. At runtime, the third test here takes the service back out of the very kernel
 * `start` returned and shows the same call dying — which is what a missing provider is, and what
 * the other tests would meet if boot stopped building it.
 */

import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Context, Effect, Exit, Option, Schema} from "effect";
import {start} from "../../boot.ts";
import {SpellBridge} from "../../commands/bridge/index.ts";
import {SpellExecutor} from "../../commands/executor.ts";
import type {Client} from "../../commands/scope.ts";
import {
	ClientId,
	type SpellPath,
	type Scope as SpellScope,
	WorkspaceId,
} from "../../commands/spell.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessId} from "../../process/process.ts";
import {CallId} from "../../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellCall, type SpellReply} from "../../protocol/messages.ts";
import {ShellDispatch} from "../commands/dispatch.ts";
import {activeWorkspace, windowIds} from "../core/index.ts";
import {wiredShellEffects} from "../host/effects.ts";
import {shellGraphNode, shellId, shellNode, shellProgram, shellStateOf} from "../program.ts";

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

const io = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({try: run, catch: (cause) => new TestIo({cause})});

const tempDir = Effect.acquireRelease(
	io(() => mkdtemp(join(tmpdir(), "tuval-shell-dispatch-"))),
	(dir) => Effect.ignore(io(() => rm(dir, {recursive: true, force: true}))),
);

/** The shell is spawned at its graph node's id, so the desk's process id is known before boot. */
const shellProcessId = ProcessId.make(shellNode);

const workspace = WorkspaceId.make("ws-1");
const client: Client = {id: ClientId.make("proof"), workspace};
const scope: SpellScope = {client: client.id, workspace};

const call = (path: SpellPath, args: unknown): SpellCall =>
	new SpellCall({
		type: "spell.call",
		version: PROTOCOL_VERSION,
		id: CallId.make("c-1"),
		path,
		args,
	});

/**
 * One app, as `.tuval/tuval.config.ts` builds it minus the demo rows. `withDesk: false` registers
 * the same shell row against a graph that plans no node for it, which is the config that boots
 * without a desk — the row's spells are still registered, so the call has somewhere to arrive and
 * nowhere to land.
 */
const bootDesk = Effect.fn("proof.bootDesk")(function* (withDesk = true) {
	const stateDir = yield* tempDir;
	return yield* start({
		programs: [shellProgram({effects: wiredShellEffects({shellProcessId})})],
		graph: {nodes: withDesk ? [shellGraphNode] : []},
		stateDir,
	});
});

/** The desk as its own process holds it, which is the state a spell's Msg has to have moved. */
const readDesk = Effect.fn("proof.readDesk")(function* (kernel: Context.Context<Processes>) {
	const handle = yield* Context.get(kernel, Processes).handle(shellProcessId);
	assert.isTrue(Option.isSome(handle), "the shell process is running");
	const state = shellStateOf(Option.getOrThrow(handle).getState());
	assert.isNotNull(state, "the shell process holds a shell state");
	return state;
});

const windowCount = (state: ReturnType<typeof shellStateOf>): number => {
	const active = state === null ? undefined : activeWorkspace(state);
	assert.isDefined(active, "the desk has an active workspace");
	return active === undefined ? 0 : windowIds(active).length;
};

const failureOf = (reply: SpellReply) => {
	assert.isFalse(reply.ok, `expected a refusal, got ${JSON.stringify(reply)}`);
	return reply.ok ? undefined : reply.error;
};

describe("a shell command row, called against the kernel boot builds", () => {
	it.effect("answers a reply and lands its Msg on the running desk", () =>
		Effect.gen(function* () {
			const {kernel} = yield* bootDesk();
			assert.strictEqual(windowCount(yield* readDesk(kernel)), 1);

			const reply = yield* Context.get(kernel, SpellExecutor)
				.execute(call([shellId, "window", "split-vertical"], {}), client)
				.pipe(Effect.provideContext(kernel));

			assert.isTrue(reply.ok, `the call was refused: ${JSON.stringify(reply)}`);
			assert.deepStrictEqual(reply.ok ? reply.result : undefined, {msg: "window.split"});
			assert.strictEqual(windowCount(yield* readDesk(kernel)), 2);
		}),
	);

	it.effect("answers a reply through SpellBridge, the door an agent calls through", () =>
		Effect.gen(function* () {
			const {kernel} = yield* bootDesk();
			const bridge = Context.get(kernel, SpellBridge);

			const answered = yield* bridge
				.call([shellId, "window", "split-vertical"], {}, scope)
				.pipe(Effect.provideContext(kernel));
			assert.deepStrictEqual(answered, {msg: "window.split"});
			assert.strictEqual(windowCount(yield* readDesk(kernel)), 2);

			// A refusal is a value on the bridge's error channel, never a defect: the caller is an
			// agent's tool, and a tool that dies takes its whole session with it.
			const exit = yield* Effect.exit(
				bridge
					.call([shellId, "window", "focus"], {window: ""}, scope)
					.pipe(Effect.provideContext(kernel)),
			);
			assert.isTrue(Exit.isFailure(exit), "the bridge accepted an argument the row refuses");
			assert.isFalse(
				Exit.isFailure(exit) && Cause.hasDies(exit.cause),
				"the bridge died on a bad argument instead of refusing",
			);
			assert.strictEqual(windowCount(yield* readDesk(kernel)), 2);
		}),
	);

	it.effect("dies on the same call once the provider is taken back out of the kernel", () =>
		Effect.gen(function* () {
			const {kernel} = yield* bootDesk();
			const withoutDispatch = Context.omit(ShellDispatch)(kernel);

			const exit = yield* Effect.exit(
				Context.get(kernel, SpellExecutor)
					.execute(call([shellId, "window", "split-vertical"], {}), client)
					.pipe(Effect.provideContext(withoutDispatch)),
			);

			assert.isTrue(Exit.isFailure(exit), "a kernel missing ShellDispatch answered the call");
			assert.strictEqual(windowCount(yield* readDesk(kernel)), 1);
		}),
	);

	it.effect("refuses in the typed channel when the config planned no desk", () =>
		Effect.gen(function* () {
			const {kernel} = yield* bootDesk(false);

			const reply = yield* Context.get(kernel, SpellExecutor)
				.execute(call([shellId, "window", "split-vertical"], {}), client)
				.pipe(Effect.provideContext(kernel));

			assert.strictEqual(failureOf(reply)?.tag, "tuval/shell/NoDesk");
		}),
	);
});
