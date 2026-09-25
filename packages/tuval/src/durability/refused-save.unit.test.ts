/**
 * A save the program cannot read is refused by tea's own load (`refuse`, demlik #316), and the
 * process then starts with no store at all (#9793). The refusal is proven at both ends: the store
 * `Checkpoints.open` hands tea answers `migrate` with a `Refusal`, so tea's `ready` fails on load;
 * and the process a restore brings back over that save runs, shows the program's own "couldn't
 * restore" state, and leaves the file exactly as it found it, byte for byte, across a transition,
 * a stop and a second boot.
 */

import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {defineMachine, type Store, StoreRefusedError} from "@demlik/tea";
import {run} from "@demlik/tea/effect";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Layer, Option, Schema} from "effect";
import {Processes} from "../process/Processes.ts";
import {ProcessId} from "../process/process.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {Checkpoints} from "./Checkpoints.ts";
import {restore} from "./restore.ts";
import {type CheckpointStores, fileStores} from "./stores.ts";

type Saved = {readonly kind: "read"; readonly count: number};
type State = Saved | {readonly kind: "unreadable"; readonly pokes: number};
type Msg = {readonly type: "tick"};

const isSaved = (raw: unknown): raw is Saved =>
	typeof raw === "object" &&
	raw !== null &&
	(raw as {kind?: unknown}).kind === "read" &&
	typeof (raw as {count?: unknown}).count === "number";

const reader = ProgramId.make("reader");
const PROCESS = ProcessId.make("reader-refused");

const core = defineMachine<State, Msg, never, never, unknown>({
	init: (loaded) =>
		loaded === null
			? [{kind: "read", count: 0}, []]
			: [isSaved(loaded) ? loaded : {kind: "unreadable", pokes: 0}, []],
	update: {
		tick: (state) =>
			state.kind === "read"
				? [{...state, count: state.count + 1}, []]
				: [{...state, pokes: state.pokes + 1}, []],
	},
});

const readerProgram: AnyProgram = {
	id: reader,
	core,
	ports: {},
	handlers: {},
	restorable: isSaved,
	capabilities: [],
	identity: {package: "@kampus/tuval", program: "reader", version: "1.0.0", digest: "sha256:r"},
	placement: {host: "local"},
} satisfies Program<State, Msg, never, never, unknown, never, never>;

const kernel = (stores: CheckpointStores) =>
	Processes.layer.pipe(
		Layer.provideMerge(Checkpoints.layer(stores)),
		Layer.provideMerge(Registry.layer([readerProgram])),
	);

class TestIo extends Schema.TaggedError<TestIo>()("TestIo", {cause: Schema.Defect()}) {}

const io = <A>(body: () => Promise<A>) =>
	Effect.tryPromise({try: body, catch: (cause) => new TestIo({cause})});

/**
 * Indented and newline-terminated on purpose: `fileStore` writes compact JSON, so any save over this
 * file changes its bytes even when it writes the same value back.
 */
const refusedBytes = `${JSON.stringify(
	{programId: "reader", version: "1.0.0", state: {kind: "lost"}},
	null,
	2,
)}\n`;

/** A state dir holding one manifest row and the save the reader cannot read. */
const seeded = Effect.gen(function* () {
	const dir = yield* io(() => mkdtemp(join(tmpdir(), "tuval-refused-save-")));
	yield* io(() => mkdir(join(dir, "processes")));
	yield* io(() =>
		writeFile(
			join(dir, "manifest.json"),
			JSON.stringify({processes: [{id: PROCESS, programId: "reader", parentId: null}]}),
		),
	);
	const save = join(dir, "processes", `${PROCESS}.json`);
	yield* io(() => writeFile(save, refusedBytes));
	return {dir, save};
});

describe("a save the program's migration refuses", () => {
	it.effect("is refused by tea's own load, which fails ready with StoreFailed on load", () =>
		Effect.gen(function* () {
			const {dir} = yield* seeded;
			const stores = fileStores(dir);
			const failed = yield* Effect.gen(function* () {
				const checkpoints = yield* Checkpoints;
				const opened = yield* checkpoints.open({
					id: PROCESS,
					programId: reader,
					parentId: Option.none(),
					version: "1.0.0",
					restorable: isSaved,
				});
				const booting = yield* run(core, {store: opened.store as Store<State>});
				return yield* Effect.flip(booting.ready);
			}).pipe(Effect.scoped, Effect.provide(Checkpoints.layer(stores)));

			assert.strictEqual(failed._tag, "StoreFailed");
			assert.strictEqual(failed.operation, "load");
			assert.instanceOf(failed.cause, StoreRefusedError);
			yield* io(() => rm(dir, {recursive: true, force: true}));
		}),
	);

	it.effect(
		"starts the process with no store, and leaves that save byte-identical on disk across a transition, a stop and a second boot",
		() =>
			Effect.gen(function* () {
				const {dir, save} = yield* seeded;
				const stores = fileStores(dir);

				yield* Effect.gen(function* () {
					const [handle] = yield* restore(Context.empty());
					assert.strictEqual(handle!.id, PROCESS);
					assert.deepStrictEqual(handle!.getState(), {kind: "unreadable", pokes: 0});
					// A transition a store-backed run would save, so a store left in place would show here.
					yield* handle!.dispatch({type: "tick"});
					assert.deepStrictEqual(handle!.getState(), {kind: "unreadable", pokes: 1});
				}).pipe(Effect.provide(kernel(stores)));

				assert.strictEqual(yield* io(() => readFile(save, "utf8")), refusedBytes);

				// The second boot reads the same bytes and refuses them again, rather than restoring a
				// state an earlier boot wrote over them.
				yield* Effect.gen(function* () {
					const [handle] = yield* restore(Context.empty());
					assert.deepStrictEqual(handle!.getState(), {kind: "unreadable", pokes: 0});
				}).pipe(Effect.provide(kernel(stores)));

				assert.strictEqual(yield* io(() => readFile(save, "utf8")), refusedBytes);
				yield* io(() => rm(dir, {recursive: true, force: true}));
			}),
	);
});
