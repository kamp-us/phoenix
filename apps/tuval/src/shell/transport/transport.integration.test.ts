/**
 * The transport over a real local WebSocket: a kernel on an ephemeral loopback port, a page
 * attaching to it, and every claim #7556 makes about that pair proven against the wire rather than
 * against a double. The kernel here is the real one — `Registry`, `Checkpoints`, `Processes`,
 * `ProcessTable`, `ProcessTablePort` — built over `memoryStores`, so the restart test is a real
 * stop and a real boot from the checkpoint the stop wrote.
 */

import {type Cmd, DispatchDiscardedError, defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Exit, Fiber, Layer, Option, Queue, Redacted, Scope, Stream} from "effect";
import {Socket} from "effect/unstable/socket";
import type {SpellPath} from "../../commands/spell.ts";
import {Checkpoints} from "../../durability/Checkpoints.ts";
import {type CheckpointStores, memoryStores} from "../../durability/stores.ts";
import {Processes} from "../../process/Processes.ts";
import type {ProcessTable} from "../../process/ProcessTable.ts";
import {type ProcessHandle, ProcessId} from "../../process/process.ts";
import {CallId} from "../../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellCall} from "../../protocol/messages.ts";
import {type DuplicateProgramId, ProgramNotFound} from "../../registry/errors.ts";
import {
	type AnyProgram,
	type Program,
	ProgramId,
	type RendererRef,
} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {ProcessTablePort} from "../../table/ProcessTablePort.ts";
import {scriptedSpellChannel} from "../host/fixtures.ts";
import {defaultPrefixTable} from "../keys/index.ts";
import type {DispatchResult, ProcessView} from "../window/host.ts";
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
const stamperProgramId = ProgramId.make("tuval/stamper");
const shellProcess = ProcessId.make("shell");
const painterProcess = ProcessId.make("painter");
const stamperProcess = ProcessId.make("stamper");

type StampState = {readonly last: string};
type StampMsg = {readonly type: "stamp"; readonly stamp: string};
type StampCmd = {readonly type: "settle"};

/**
 * One slot, written by every Msg, plus a Cmd that takes a tick to settle. That is the shape of the
 * shell's `lastPress` and of the window a second press lands in while the first is still folding —
 * the case where an ack read *after* its fold answers about somebody else's Msg (#8274).
 */
const stamperCore = defineMachine<StampState, StampMsg, StampCmd, never, unknown>({
	init: (loaded) => [loaded ?? {last: ""}, []],
	update: {
		stamp: (_state: StampState, msg: StampMsg): readonly [StampState, ReadonlyArray<StampCmd>] => [
			{last: msg.stamp},
			[{type: "settle"}],
		],
	},
	// Demlik's `Machine` demands a Promise `interpret` beside the row's `handlers`; the host never
	// reads it (#7576).
	interpret: {settle: () => Promise.resolve()},
});

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

const spellCall = (path: SpellPath, args: unknown): SpellCall =>
	new SpellCall({
		type: "spell.call",
		version: PROTOCOL_VERSION,
		id: CallId.make(crypto.randomUUID()),
		path,
		args,
	});

const stamperRow: AnyProgram = {
	id: stamperProgramId,
	core: stamperCore,
	ports: {},
	handlers: {settle: () => Effect.as(Effect.sleep("5 millis"), [])},
	capabilities: [],
	renderer: ref("tuval/stamper"),
	identity: {
		package: "@kampus/tuval",
		program: stamperProgramId,
		version: "1.0.0",
		digest: `sha256:${stamperProgramId}`,
	},
	placement: {host: "local"},
} satisfies Program<StampState, StampMsg, StampCmd, never, unknown, never, never>;

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
		table: defaultPrefixTable,
		handles: (id) => Effect.sync(() => Option.fromNullishOr(built.handles.get(id))),
		spells: yield* scriptedSpellChannel(),
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

/** The state an acknowledgement says its own Msg left behind. Asserts the ack even carries one. */
const answered = (result: DispatchResult): unknown => {
	assert.strictEqual(result._tag, "Delivered");
	const view = (result as {readonly view?: {readonly state: unknown}}).view;
	assert.ok(view !== undefined);
	return view.state;
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
				// The acknowledgement carries the state the Msg left behind, so a caller learns what its
				// own dispatch did without racing the state pump (#8274).
				assert.deepStrictEqual(result, {
					_tag: "Delivered",
					view: {revision: 1, state: {windows: ["root", "w2"]}},
				});
				assert.deepStrictEqual(stateOf(yield* Queue.take(seen)), {windows: ["root", "w2"]});
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"answers two dispatches in flight each with its own Msg's state, never with the later one's",
		() =>
			// The ack used to be a *second* read taken after the fold, so with two presses in flight it
			// carried whichever Msg folded last. `replyIn` reads a stamp that is not its own as
			// `Refused`, and `Refused` forwards nothing — the key was gone with no trace (#8274).
			Effect.gen(function* () {
				const app = yield* served(memoryStores(), Registry.layer([...programs, stamperRow]));
				const processes = Context.get(app.context, Processes);
				app.handles.set(
					stamperProcess,
					yield* Effect.orDie(
						processes.spawn(stamperProgramId, {id: stamperProcess, services: Context.empty()}),
					),
				);
				const attached = yield* page(app.server.launchUrl);
				const stamper = yield* attached.attachProcess<StampState, StampMsg>(stamperProcess);
				const [first, second] = yield* Effect.all(
					[
						stamper.dispatch({type: "stamp", stamp: "press-1"}),
						stamper.dispatch({type: "stamp", stamp: "press-2"}),
					],
					{concurrency: "unbounded"},
				);

				// Which of the two the kernel folds first is the socket's business, so the claim is per
				// acknowledgement: each one answers about the Msg it acknowledges.
				assert.deepStrictEqual(answered(first), {last: "press-1"});
				assert.deepStrictEqual(answered(second), {last: "press-2"});
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
					dispatchFolded: (msg) =>
						Effect.succeed({
							settled: Exit.fail(new DispatchDiscardedError(msg.type)),
							summary: {lifecycle: "running", revision: 0, state: {windows: ["root"]}},
						}),
				};
				const server = yield* serve({
					token: mintLaunchToken(),
					port: 0,
					table: defaultPrefixTable,
					handles: (id) =>
						Effect.sync(() =>
							id === shellProcess
								? Option.some(discarding)
								: Option.fromNullishOr(built.handles.get(id)),
						),
					spells: yield* scriptedSpellChannel(),
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
		"a page is sent the key grammar the kernel serves, over a real socket and back through JSON",
		() =>
			Effect.gen(function* () {
				const app = yield* served(memoryStores());
				const attached = yield* page(app.server.launchUrl);
				const told = yield* Stream.runHead(attached.keys);
				// Value-equal, not the same object: it crossed as JSON and its `Duration` was rebuilt.
				assert.deepStrictEqual(Option.getOrNull(told), defaultPrefixTable);
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

	it.live(
		"a spell call from the page is answered by the kernel's executor, and an unknown path comes back as its refusal",
		() =>
			Effect.gen(function* () {
				const app = yield* served(memoryStores());
				const attached = yield* page(app.server.launchUrl);

				const answered = yield* attached.call(spellCall(["desk", "echo"], {word: "hello"}));
				assert.isTrue(answered.ok);
				assert.deepStrictEqual(answered.ok ? answered.result : null, {word: "hello"});

				const call = spellCall(["desk", "nope"], {});
				const refused = yield* attached.call(call);
				assert.isFalse(refused.ok);
				// The executor's own reply, unchanged: the page never builds a refusal of its own.
				assert.deepStrictEqual(
					refused.ok ? null : refused.error.tag,
					"tuval/commands/UnknownSpell",
				);
				assert.strictEqual(refused.id, call.id);
			}).pipe(Effect.scoped),
		TIMEOUT,
	);

	it.live(
		"two calls in flight each read their own reply, and a socket that goes away fails the ones still waiting",
		() =>
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const app = yield* Effect.provideService(served(memoryStores()), Scope.Scope, scope);
				const attached = yield* page(app.server.launchUrl);

				const both = yield* Effect.all(
					[
						attached.call(spellCall(["desk", "echo"], {word: "first"})),
						attached.call(spellCall(["desk", "echo"], {word: "second"})),
					],
					{concurrency: "unbounded"},
				);
				assert.deepStrictEqual(
					both.map((reply) => (reply.ok ? reply.result : null)),
					[{word: "first"}, {word: "second"}],
				);

				const waiting = yield* Effect.forkChild(attached.call(spellCall(["desk", "forever"], {})));
				yield* Effect.sleep("200 millis");
				yield* Scope.close(scope, Exit.void);
				assert.isTrue(Exit.isFailure(yield* Fiber.await(waiting)));
			}).pipe(Effect.scoped),
		TIMEOUT,
	);
});
