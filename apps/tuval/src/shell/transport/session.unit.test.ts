import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Semaphore,
	Stream,
} from "effect";
import {Socket} from "effect/unstable/socket";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {memoryStores} from "../../durability/stores.ts";
import {Processes} from "../../process/Processes.ts";
import {ProcessTable} from "../../process/ProcessTable.ts";
import {ProcessId} from "../../process/process.ts";
import {type AnyProgram, ProgramId} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {ProcessTablePort} from "../../table/ProcessTablePort.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import {session} from "./server.ts";
import {ATTACH_KIND, PROCESS_STATE_KIND} from "./wire.ts";

const processId = ProcessId.make("retained");
const program: AnyProgram = {
	id: ProgramId.make("socket-test"),
	core: defineMachine({init: () => [{count: 0}, []], update: {}}),
	ports: {},
	handlers: {},
	capabilities: [],
	placement: {host: "local"},
	identity: {package: "@kampus/tuval", program: "socket-test", version: "1", digest: "socket-test"},
};

const controlled = Effect.gen(function* () {
	const closed = yield* Deferred.make<void, Socket.SocketError>();
	const ready = yield* Deferred.make<void>();
	const writes: string[] = [];
	const socket: Socket.Socket = Socket.Socket.of({
		[Socket.TypeId]: Socket.TypeId,
		writer: Effect.succeed((chunk) =>
			Effect.sync(() => {
				if (typeof chunk === "string") writes.push(chunk);
			}),
		),
		run: () => Effect.never,
		runRaw: () => Effect.never,
		runString: (handler, options) =>
			Effect.gen(function* () {
				yield* options?.onOpen ?? Effect.void;
				const handled = handler(JSON.stringify({kind: ATTACH_KIND, processId}));
				if (handled !== undefined) yield* handled;
				yield* Deferred.succeed(ready, undefined);
				yield* Deferred.await(closed);
			}),
	});
	return {socket, closed, ready, writes};
});

const kernel = Effect.gen(function* () {
	const context = yield* Layer.build(
		ProcessTablePort.layer.pipe(
			Layer.provideMerge(Processes.layer),
			Layer.provideMerge(Checkpoints.layer(memoryStores())),
			Layer.provideMerge(Registry.layer([program])),
		),
	);
	const processes = Context.get(context, Processes);
	const handle = yield* processes.spawn(program.id, {id: processId, services: Context.empty()});
	const pages: Parameters<typeof session>[5] = new Set();
	const lock = yield* Semaphore.make(1);
	const run = (socket: Socket.Socket) =>
		session(
			socket,
			processes.handle,
			Effect.succeed(() => Effect.die("unexpected spell")),
			Stream.never,
			defaultPrefixTable,
			pages,
			lock,
		).pipe(Effect.scoped, Effect.provideContext(context));
	return {run, pages, handle, table: Context.get(context, ProcessTable)};
});

const closeError = (code: number) =>
	new Socket.SocketError({reason: new Socket.SocketCloseError({code})});

describe("page socket session endings", () => {
	for (const code of [1000, 1001, 1006]) {
		it.effect(`ends close ${code} successfully and retains the process for another page`, () =>
			Effect.gen(function* () {
				const built = yield* kernel;
				const first = yield* controlled;
				const fiber = yield* Effect.forkScoped(built.run(first.socket));
				yield* Deferred.await(first.ready);
				assert.strictEqual(built.pages.size, 1);
				assert.isTrue(first.writes.some((text) => text.includes(PROCESS_STATE_KIND)));
				yield* Deferred.fail(first.closed, closeError(code));
				const exit = yield* Fiber.await(fiber);
				assert.isTrue(Exit.isSuccess(exit));
				assert.strictEqual(built.pages.size, 0);
				assert.strictEqual((yield* built.table.get(processId)).id, processId);
				assert.deepStrictEqual(built.handle.getState(), {count: 0});
				const second = yield* controlled;
				const reattached = yield* Effect.forkScoped(built.run(second.socket));
				yield* Deferred.await(second.ready);
				assert.strictEqual(built.pages.size, 1);
				assert.isTrue(
					second.writes.some(
						(text) => text.includes(PROCESS_STATE_KIND) && text.includes(processId),
					),
				);
				yield* Deferred.fail(second.closed, closeError(1000));
				assert.isTrue(Exit.isSuccess(yield* Fiber.await(reattached)));
				assert.strictEqual(built.pages.size, 0);
			}).pipe(Effect.scoped),
		);
	}
	for (const reason of [
		new Socket.SocketReadError({cause: new Error("read failure")}),
		new Socket.SocketWriteError({cause: new Error("write failure")}),
		new Socket.SocketOpenError({kind: "Unknown", cause: new Error("open failure")}),
		...[1005, 1008, 1011, 4000].map((code) => new Socket.SocketCloseError({code})),
	]) {
		it.effect(`preserves the exact reported ${reason._tag} ${reason.message}`, () =>
			Effect.gen(function* () {
				const built = yield* kernel;
				const page = yield* controlled;
				const fiber = yield* Effect.forkScoped(built.run(page.socket));
				yield* Deferred.await(page.ready);
				const original = new Socket.SocketError({reason});
				yield* Deferred.fail(page.closed, original);
				const exit = yield* Fiber.await(fiber);
				assert.isTrue(Exit.isFailure(exit));
				if (Exit.isFailure(exit))
					assert.strictEqual(Option.getOrUndefined(Cause.findErrorOption(exit.cause)), original);
				assert.strictEqual(built.pages.size, 0);
				assert.strictEqual((yield* built.table.get(processId)).id, processId);
			}).pipe(Effect.scoped),
		);
	}
});
