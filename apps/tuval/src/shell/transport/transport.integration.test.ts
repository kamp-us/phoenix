/**
 * The transport over a real local WebSocket: a kernel on an ephemeral loopback port, a page
 * attaching to it, and every claim #7556 makes about that pair proven against the wire rather than
 * against a double. The kernel here is the real one — `Registry`, `Checkpoints`, `Processes`,
 * `ProcessTable`, `ProcessTablePort` — built over `memoryStores`, so the restart test is a real
 * stop and a real boot from the checkpoint the stop wrote.
 */

import {type Cmd, DispatchDiscardedError, defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option, Queue, Redacted, Scope, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {type CheckpointStores, memoryStores} from "../../durability/stores.ts";
import {Processes} from "../../process/Processes.ts";
import type {ProcessTable} from "../../process/ProcessTable.ts";
import {type ProcessHandle, ProcessId} from "../../process/process.ts";
import {type DuplicateProgramId, ProgramNotFound} from "../../registry/errors.ts";
import {
	type AnyProgram,
	type Program,
	ProgramId,
	type RendererRef,
} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {ProcessTablePort} from "../../table/ProcessTablePort.ts";
import type {ProcessView} from "../window/host.ts";
import {attach} from "./client.ts";
import {PlacementUnsupported} from "./errors.ts";
import {mintLaunchToken, TOKEN_PARAM} from "./handshake.ts";
import {serve} from "./server.ts";

const TIMEOUT = 20_000;

type DeskState = {readonly windows: ReadonlyArray<string>};
type DeskMsg = {readonly type: "split"; readonly window: string};

const shellProgramId = ProgramId.make("tuval/shell");
const painterProgramId = ProgramId.make("tuval/painter");
const notesProgramId = ProgramId.make("tuval/notes");
const daemonProgramId = ProgramId.make("tuval/daemon");
const shellProcess = ProcessId.make("shell");
const painterProcess = ProcessId.make("painter");

const deskCore = defineMachine<DeskState, DeskMsg, Cmd<never>, never, unknown>({
	init: (loaded) => [loaded ?? {windows: ["root"]}, []],
	update: {
		split: (state: DeskState, msg: DeskMsg): readonly [DeskState, ReadonlyArray<Cmd<never>>] => [
			{windows: [...state.windows, msg.window]},
			[],
		],
	},
});

const deskRow = (id: ProgramId, host: "local" | "browser", renderer?: RendererRef): AnyProgram =>
	({
		id,
		core: deskCore,
		ports: {},
		handlers: {},
		capabilities: [],
		...(renderer === undefined ? {} : {renderer}),
		identity: {package: "@kampus/tuval", program: id, version: "1.0.0", digest: `sha256:${id}`},
		placement: {host},
	}) satisfies Program<DeskState, DeskMsg, Cmd<never>, never, unknown, never, never>;

const ref = (name: string): RendererRef => ({kind: "host-native", ref: name});

/** Three rows a window can show and one that cannot: what the catalog must and must not carry. */
const programs: ReadonlyArray<AnyProgram> = [
	deskRow(shellProgramId, "local", ref("tuval/shell")),
	deskRow(painterProgramId, "browser", ref("tuval/painter")),
	deskRow(notesProgramId, "local", ref("tuval/notes")),
	deskRow(daemonProgramId, "local"),
];

interface Kernel {
	readonly context: Context.Context<
		Registry | Checkpoints | Processes | ProcessTable | ProcessTablePort
	>;
	readonly handles: Map<ProcessId, ProcessHandle>;
}

/**
 * A registry whose list is read at call time, so a test can change what the kernel offers while the
 * socket stays open — the shape a config reload would leave behind (#7743).
 */
const movingRegistry = (rows: {current: ReadonlyArray<AnyProgram>}) =>
	Layer.succeed(
		Registry,
		Registry.of({
			resolve: (id) =>
				Effect.suspend(() => {
					const row = rows.current.find((one) => one.id === id);
					return row === undefined ? Effect.fail(new ProgramNotFound({id})) : Effect.succeed(row);
				}),
			list: Effect.sync(() => rows.current),
		}),
	);

/** The real kernel over the given stores, with the shell and the browser-placed program spawned. */
const kernel = Effect.fn("test.kernel")(function* (
	stores: CheckpointStores,
	registry: Layer.Layer<Registry, DuplicateProgramId> = Registry.layer(programs),
) {
	const context = yield* Layer.build(
		ProcessTablePort.layer.pipe(
			Layer.provideMerge(Processes.layer),
			Layer.provideMerge(Checkpoints.layer(stores)),
			Layer.provideMerge(registry),
		),
	).pipe(Effect.orDie);
	const processes = Context.get(context, Processes);
	const handles = new Map<ProcessId, ProcessHandle>();
	for (const [programId, processId] of [
		[shellProgramId, shellProcess],
		[painterProgramId, painterProcess],
	] as const) {
		const handle = yield* Effect.orDie(
			processes.spawn(programId, {id: processId, services: Context.empty()}),
		);
		handles.set(processId, handle);
	}
	return {context, handles} satisfies Kernel;
});

/** A kernel plus a served socket on an ephemeral loopback port, torn down with the caller's Scope. */
const served = Effect.fn("test.served")(function* (
	stores: CheckpointStores,
	registry?: Layer.Layer<Registry, DuplicateProgramId>,
) {
	const built = yield* kernel(stores, registry);
	const token = mintLaunchToken();
	const server = yield* serve({
		token,
		port: 0,
		handles: (id) => Effect.sync(() => Option.fromNullishOr(built.handles.get(id))),
	}).pipe(Effect.provideContext(built.context), Effect.orDie);
	return {...built, token, server};
});

const page = (url: string) =>
	attach(url, {shellProgram: shellProgramId}).pipe(
		Effect.provide(Socket.layerWebSocketConstructorGlobal),
	);

/** Every view a stream emits, in order, taken one at a time so a read proves the subscription is live. */
const watch = <S>(stream: Stream.Stream<ProcessView<S>, never>) =>
	Effect.gen(function* () {
		const seen = yield* Queue.unbounded<ProcessView<S>>();
		yield* Effect.forkScoped(
			Stream.runForEach(stream, (view) => Effect.asVoid(Queue.offer(seen, view))),
		);
		return seen;
	});

const stateOf = <S>(view: ProcessView<S>): S => {
	assert.strictEqual(view._tag, "Live");
	return (view as {readonly state: S}).state;
};

/** A raw client, for the two questions the Effect socket abstracts away: the upgrade, and a bad frame. */
const rawSocket = (url: string) =>
	Effect.callback<{readonly opened: boolean; readonly closeCode: number | null}>((resume) => {
		const ws = new WebSocket(url);
		let opened = false;
		ws.addEventListener("open", () => {
			opened = true;
			ws.send("{not a frame");
		});
		ws.addEventListener("error", () => resume(Effect.succeed({opened, closeCode: null})));
		ws.addEventListener("close", (event) =>
			resume(Effect.succeed({opened, closeCode: event.code})),
		);
	});

describe("the page-to-kernel transport", () => {
	it.live(
		"a dispatch from the page reaches the named process and its next state comes back over the socket",
		() =>
			Effect.gen(function* () {
				const app = yield* served(memoryStores());
				const attached = yield* page(app.server.launchUrl);
				const shell = yield* attached.attachProcess<DeskState, DeskMsg>(shellProcess);
				const seen = yield* watch(shell.readProcess);

				assert.deepStrictEqual(stateOf(yield* Queue.take(seen)), {windows: ["root"]});
				const result = yield* shell.dispatch({type: "split", window: "w2"});
				assert.deepStrictEqual(result, {_tag: "Delivered"});
				assert.deepStrictEqual(stateOf(yield* Queue.take(seen)), {windows: ["root", "w2"]});
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"acks a Msg the actor discarded as ProcessGone, never as Delivered",
		() =>
			// A blanket `catchCause` answered Delivered for every failure `dispatch` raises, so a Msg
			// the actor threw away came back to the page as if it had landed (#7499).
			Effect.gen(function* () {
				const built = yield* kernel(memoryStores());
				const real = built.handles.get(shellProcess);
				assert.ok(real !== undefined);
				const discarding: ProcessHandle = {
					...real,
					dispatch: (msg) => Effect.fail(new DispatchDiscardedError(msg.type)),
				};
				const server = yield* serve({
					token: mintLaunchToken(),
					port: 0,
					handles: (id) =>
						Effect.sync(() =>
							id === shellProcess
								? Option.some(discarding)
								: Option.fromNullishOr(built.handles.get(id)),
						),
				}).pipe(Effect.provideContext(built.context), Effect.orDie);

				const attached = yield* page(server.launchUrl);
				const shell = yield* attached.attachProcess<DeskState, DeskMsg>(shellProcess);
				assert.deepStrictEqual(yield* shell.dispatch({type: "split", window: "w2"}), {
					_tag: "ProcessGone",
					processId: shellProcess,
				});
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"a socket drop followed by re-attach yields the same current state and replays no dispatch",
		() =>
			Effect.gen(function* () {
				const app = yield* served(memoryStores());

				yield* Effect.scopedWith(
					Effect.fnUntraced(function* (scope) {
						const first = yield* Scope.provide(page(app.server.launchUrl), scope);
						const shell = yield* first.attachProcess<DeskState, DeskMsg>(shellProcess);
						yield* shell.dispatch({type: "split", window: "w2"});
					}),
				);

				const second = yield* page(app.server.launchUrl);
				const shell = yield* second.attachProcess<DeskState, DeskMsg>(shellProcess);
				const seen = yield* watch(shell.readProcess);
				// The one split, once: what came back is current state, not a transcript replayed.
				assert.deepStrictEqual(stateOf(yield* Queue.take(seen)), {windows: ["root", "w2"]});
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"a kernel stop and boot followed by re-attach yields the restored state",
		() =>
			Effect.gen(function* () {
				const stores = memoryStores();
				let url = "";

				yield* Effect.scopedWith(
					Effect.fnUntraced(function* (scope) {
						const app = yield* Scope.provide(served(stores), scope);
						url = app.server.launchUrl;
						const attached = yield* Scope.provide(page(app.server.launchUrl), scope);
						const shell = yield* attached.attachProcess<DeskState, DeskMsg>(shellProcess);
						yield* shell.dispatch({type: "split", window: "w2"});
						const seen = yield* Scope.provide(watch(shell.readProcess), scope);
						assert.deepStrictEqual(stateOf(yield* Queue.take(seen)), {windows: ["root", "w2"]});
					}),
				);

				const rebooted = yield* served(stores);
				assert.notStrictEqual(rebooted.server.launchUrl, url);
				const attached = yield* page(rebooted.server.launchUrl);
				const shell = yield* attached.attachProcess<DeskState, DeskMsg>(shellProcess);
				const seen = yield* watch(shell.readProcess);
				assert.deepStrictEqual(stateOf(yield* Queue.take(seen)), {windows: ["root", "w2"]});
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"a process whose placement is not the node host is refused with a typed error naming the placement",
		() =>
			Effect.gen(function* () {
				const app = yield* served(memoryStores());
				const attached = yield* page(app.server.launchUrl);
				const refused = yield* Effect.flip(attached.attachProcess(painterProcess));
				assert.instanceOf(refused, PlacementUnsupported);
				assert.strictEqual(refused.placement, "browser");
				assert.include(refused.message, "browser");
				// The socket survives the refusal: the shell on the same socket still attaches.
				const shell = yield* attached.attachProcess<DeskState, DeskMsg>(shellProcess);
				const seen = yield* watch(shell.readProcess);
				assert.deepStrictEqual(stateOf(yield* Queue.take(seen)), {windows: ["root"]});
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"the shell's state travels the ordinary process path: readShell finds it through the table",
		() =>
			Effect.gen(function* () {
				const app = yield* served(memoryStores());
				const attached = yield* page(app.server.launchUrl);
				const seen = yield* watch(attached.readShell<DeskState>().pipe(Stream.orDie));
				assert.deepStrictEqual(stateOf(yield* Queue.take(seen)), {windows: ["root"]});

				const rows = yield* Stream.runHead(attached.rows);
				assert.deepStrictEqual(
					Option.getOrElse(rows, () => [])
						.map((row) => [row.id, row.programId])
						.sort(),
					[
						[painterProcess, painterProgramId],
						[shellProcess, shellProgramId],
					],
				);
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"two clients over one shell process see the same state: a split from one shows on the other",
		() =>
			Effect.gen(function* () {
				const app = yield* served(memoryStores());
				const one = yield* page(app.server.launchUrl);
				const two = yield* page(app.server.launchUrl);
				const shellOne = yield* one.attachProcess<DeskState, DeskMsg>(shellProcess);
				const shellTwo = yield* two.attachProcess<DeskState, DeskMsg>(shellProcess);
				const seenOne = yield* watch(shellOne.readProcess);
				const seenTwo = yield* watch(shellTwo.readProcess);

				assert.deepStrictEqual(stateOf(yield* Queue.take(seenOne)), {windows: ["root"]});
				assert.deepStrictEqual(stateOf(yield* Queue.take(seenTwo)), {windows: ["root"]});
				yield* shellOne.dispatch({type: "split", window: "w2"});
				assert.deepStrictEqual(stateOf(yield* Queue.take(seenOne)), {windows: ["root", "w2"]});
				assert.deepStrictEqual(stateOf(yield* Queue.take(seenTwo)), {windows: ["root", "w2"]});
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"a page is offered every windowed program the registry holds, and never the headless one",
		() =>
			Effect.gen(function* () {
				const app = yield* served(memoryStores());
				const attached = yield* page(app.server.launchUrl);
				const offered = yield* Stream.runHead(
					Stream.filter(attached.programs, (list) => list.length > 0),
				);
				assert.deepStrictEqual(
					Option.getOrElse(offered, () => [])
						.map((program) => [program.programId, program.label, program.renderer.ref])
						.sort(),
					[
						[notesProgramId, notesProgramId, "tuval/notes"],
						[painterProgramId, painterProgramId, "tuval/painter"],
						[shellProgramId, shellProgramId, "tuval/shell"],
					],
				);
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"a registry change reaches a page that is already attached, with no reload of its own",
		() =>
			Effect.gen(function* () {
				const rows: {current: ReadonlyArray<AnyProgram>} = {current: programs};
				const app = yield* served(memoryStores(), movingRegistry(rows));
				const attached = yield* page(app.server.launchUrl);
				const before = yield* Stream.runHead(
					Stream.filter(attached.programs, (list) => list.length === 3),
				);
				assert.strictEqual(Option.getOrElse(before, () => []).length, 3);

				const boardProgramId = ProgramId.make("tuval/board");
				rows.current = [...programs, deskRow(boardProgramId, "local", ref("tuval/board"))];
				yield* app.server.publishRegistry;

				const after = yield* Stream.runHead(
					Stream.filter(attached.programs, (list) => list.length === 4),
				);
				assert.include(
					Option.getOrElse(after, () => []).map((program) => program.programId),
					boardProgramId,
				);
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"a frame that does not decode closes the socket",
		() =>
			Effect.gen(function* () {
				const app = yield* served(memoryStores());
				const outcome = yield* rawSocket(app.server.launchUrl);
				assert.isTrue(outcome.opened);
				assert.strictEqual(outcome.closeCode, 1008);
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"a handshake without the token or with a wrong one is refused before any frame",
		() =>
			Effect.gen(function* () {
				const app = yield* served(memoryStores());
				const bare = new URL(app.server.launchUrl);
				bare.searchParams.delete(TOKEN_PARAM);
				const wrong = new URL(app.server.launchUrl);
				wrong.searchParams.set(TOKEN_PARAM, "b".repeat(64));

				const outcomes = yield* Effect.forEach(
					[bare.toString(), wrong.toString()],
					(url) => rawSocket(url),
					{concurrency: 1},
				);
				assert.deepStrictEqual(
					outcomes.map((outcome) => outcome.opened),
					[false, false],
				);
				// And the good token on the same server still opens, so the refusal is the token's.
				const good = yield* rawSocket(app.server.launchUrl);
				assert.isTrue(good.opened);
				assert.strictEqual(Redacted.value(app.token).length, 64);
			}).pipe(Effect.scoped),
		TIMEOUT,
	);
});
