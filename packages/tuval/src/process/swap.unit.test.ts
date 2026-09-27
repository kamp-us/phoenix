/**
 * `Processes.swap` (#9820): a live process moves onto a reloaded row of its program and keeps its
 * id, handle, children and state, and a state the reloaded row refuses lands in that row's own
 * refused-restore branch rather than a fresh `init`.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Context, Effect, Exit, Layer, Option} from "effect";
import {Checkpoints} from "../durability/Checkpoints.ts";
import {snapshotAt} from "../durability/fixtures.ts";
import {type CheckpointStores, memoryStores} from "../durability/stores.ts";
import {type AnyProgram, type Migrations, type Program, ProgramId} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {SwapProgramMismatch} from "./errors.ts";
import {Processes} from "./Processes.ts";
import {ProcessTable} from "./ProcessTable.ts";

type Tally =
	| {readonly type: "counting"; readonly count: number; readonly by: string}
	| {readonly type: "unreadable"; readonly raw: unknown};
type Bump = {readonly type: "bump"};

const TALLY = ProgramId.make("tally");

const isCounting = (raw: unknown): raw is Tally & {readonly type: "counting"} =>
	typeof raw === "object" &&
	raw !== null &&
	(raw as {readonly type?: unknown}).type === "counting" &&
	typeof (raw as {readonly count?: unknown}).count === "number";

interface TallyRow {
	/** What a `bump` adds, and the name it stamps on the state: the "code" a reload edits. */
	readonly step: number;
	readonly by: string;
	readonly version?: string;
	/** What `init` can read back. A version whose state shape moved reads less than v1 wrote. */
	readonly reads?: (raw: unknown) => boolean;
	readonly restorable?: (raw: unknown) => boolean;
	readonly migrations?: Migrations;
}

/** A counter whose `init` turns a state it cannot read into its own `unreadable` state. */
const tally = ({
	step,
	by,
	version = "1.0.0",
	reads = isCounting,
	restorable,
	migrations,
}: TallyRow): AnyProgram =>
	({
		id: TALLY,
		core: defineMachine<Tally, Bump, never, never, unknown>({
			init: (loaded) => [
				loaded === null || loaded === undefined
					? {type: "counting", count: 0, by}
					: isCounting(loaded) && reads(loaded) && restorable?.(loaded) !== false
						? loaded
						: {type: "unreadable", raw: loaded},
				[],
			],
			update: {
				bump: (state) => [
					state.type === "counting" ? {type: "counting", count: state.count + step, by} : state,
					[],
				],
			},
		}),
		ports: {},
		handlers: {},
		capabilities: [],
		identity: {package: "@kampus/tuval", program: "tally", version, digest: "sha256:tally"},
		placement: {host: "local"},
		...(restorable === undefined ? {} : {restorable}),
		...(migrations === undefined ? {} : {migrations}),
	}) satisfies Program<Tally, Bump, never, never, unknown, never, never>;

const OTHER = ProgramId.make("other");
const other: AnyProgram = {
	...tally({step: 1, by: "other"}),
	id: OTHER,
	identity: {package: "@kampus/tuval", program: "other", version: "1.0.0", digest: "sha256:o"},
};

const bump: Bump = {type: "bump"};

const withKernel = <A, E>(
	stores: CheckpointStores,
	body: Effect.Effect<A, E, Processes | ProcessTable>,
) =>
	body.pipe(
		Effect.provide(
			Processes.layer.pipe(
				Layer.provide([
					Registry.layer([tally({step: 1, by: "v1"}), other]),
					Checkpoints.layer(stores),
				]),
			),
		),
	);

/** A tally spawned off the registry's v1 row and bumped twice, so it holds `count: 2`. */
const bumpedTwice = Effect.gen(function* () {
	const processes = yield* Processes;
	const handle = yield* processes.spawn(TALLY, {services: Context.empty()});
	yield* handle.dispatch(bump);
	yield* handle.dispatch(bump);
	assert.deepStrictEqual(handle.getState(), {type: "counting", count: 2, by: "v1"});
	return handle;
});

describe("Processes.swap", () => {
	it.effect(
		"runs the reloaded row's update over the state it had, under the same id and handle",
		() => {
			const stores = memoryStores();
			return withKernel(
				stores,
				Effect.gen(function* () {
					const processes = yield* Processes;
					const table = yield* ProcessTable;
					const handle = yield* bumpedTwice;
					const child = yield* processes.spawn(OTHER, {
						parent: handle.id,
						services: Context.empty(),
					});

					const outcome = yield* processes.swap(handle.id, tally({step: 10, by: "v2"}));
					assert.strictEqual(outcome, "switched");
					assert.deepStrictEqual(handle.getState(), {type: "counting", count: 2, by: "v1"});

					yield* handle.dispatch(bump);
					assert.deepStrictEqual(handle.getState(), {type: "counting", count: 12, by: "v2"});
					const row = yield* table.get(handle.id);
					assert.deepStrictEqual(row.stateSummary().state, handle.getState());
					assert.deepStrictEqual(
						(yield* table.list).map((listed) => listed.id).sort(),
						[handle.id, child.id].sort(),
						"the swap closed the process's child",
					);
					const saved = yield* snapshotAt(stores, handle.id);
					assert.deepStrictEqual(saved?.state, handle.getState(), "the new run saves nothing");
				}),
			);
		},
	);

	it.effect("walks the carried state through the reloaded row's migrations", () =>
		withKernel(
			memoryStores(),
			Effect.gen(function* () {
				const processes = yield* Processes;
				const handle = yield* bumpedTwice;
				const migrated = tally({
					step: 1,
					by: "v2",
					version: "2.0.0",
					migrations: {
						"1.0.0": {
							to: "2.0.0",
							migrate: (raw) =>
								isCounting(raw) ? Option.some({...raw, count: raw.count * 100}) : Option.none(),
						},
					},
				});

				assert.strictEqual(yield* processes.swap(handle.id, migrated), "switched");
				assert.deepStrictEqual(handle.getState(), {type: "counting", count: 200, by: "v1"});
			}),
		),
	);

	it.effect(
		"lands a state the reloaded row's restorable refuses in its refused-restore branch",
		() =>
			withKernel(
				memoryStores(),
				Effect.gen(function* () {
					const processes = yield* Processes;
					const handle = yield* bumpedTwice;
					const refusing = tally({step: 1, by: "v2", restorable: () => false});

					assert.strictEqual(yield* processes.swap(handle.id, refusing), "restore-refused");
					assert.deepStrictEqual(handle.getState(), {
						type: "unreadable",
						raw: {type: "counting", count: 2, by: "v1"},
					});
				}),
			),
	);

	it.effect("lands a state no migration reaches the reloaded version from in the same branch", () =>
		withKernel(
			memoryStores(),
			Effect.gen(function* () {
				const processes = yield* Processes;
				const handle = yield* bumpedTwice;
				const bumped = tally({
					step: 1,
					by: "v2",
					version: "2.0.0",
					reads: (raw) => isCounting(raw) && raw.by === "v2",
				});

				assert.strictEqual(yield* processes.swap(handle.id, bumped), "restore-refused");
				assert.deepStrictEqual(handle.getState(), {
					type: "unreadable",
					raw: {type: "counting", count: 2, by: "v1"},
				});
			}),
		),
	);

	it.effect("refuses a row of another program and leaves the process on its run", () =>
		withKernel(
			memoryStores(),
			Effect.gen(function* () {
				const processes = yield* Processes;
				const handle = yield* bumpedTwice;

				const refused = yield* Effect.exit(processes.swap(handle.id, other));
				assert.isTrue(Exit.isFailure(refused));
				assert.deepStrictEqual(
					Exit.findErrorOption(refused),
					Option.some(new SwapProgramMismatch({id: handle.id, running: TALLY, offered: OTHER})),
				);
				yield* handle.dispatch(bump);
				assert.deepStrictEqual(handle.getState(), {type: "counting", count: 3, by: "v1"});
			}),
		),
	);

	it.effect("a stop after a swap still stops the process", () =>
		withKernel(
			memoryStores(),
			Effect.gen(function* () {
				const processes = yield* Processes;
				const table = yield* ProcessTable;
				const handle = yield* bumpedTwice;
				yield* processes.swap(handle.id, tally({step: 10, by: "v2"}));

				yield* handle.stop;
				assert.deepStrictEqual(yield* table.list, []);
				assert.isTrue(Exit.isFailure(yield* Effect.exit(handle.dispatch(bump))));
			}),
		),
	);
});
