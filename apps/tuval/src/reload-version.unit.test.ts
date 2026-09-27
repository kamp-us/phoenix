/**
 * A reload whose only change to a running program's row is a version (#9820, criterion 8): the
 * process is switched onto the reloaded row, so the state it carries walks that row's migrations.
 * The two rows share every function object, so nothing but the version and a migration's `to`
 * tells them apart.
 */

import {defineMachine} from "@demlik/tea";
import {assert, describe, it} from "@effect/vitest";
import {Checkpoints} from "@kampus/tuval-sdk/kernel/durability/Checkpoints";
import {memoryStores} from "@kampus/tuval-sdk/kernel/durability/stores";
import {Processes} from "@kampus/tuval-sdk/kernel/process/Processes";
import {
	type AnyProgram,
	type Migrations,
	type Program,
	ProgramId,
} from "@kampus/tuval-sdk/kernel/registry/program";
import {Registry} from "@kampus/tuval-sdk/kernel/registry/Registry";
import {Context, Effect, Layer, Option} from "effect";
import {applyReload, codeOf, rowsOnly} from "./reload.ts";

type Tally = {readonly count: number; readonly migrated: boolean};
type Bump = {readonly type: "bump"};

const TALLY = ProgramId.make("tally");

const core = defineMachine<Tally, Bump, never, never, unknown>({
	init: (loaded) => [(loaded as Tally | null | undefined) ?? {count: 0, migrated: false}, []],
	update: {bump: (state) => [{...state, count: state.count + 1}, []]},
});

const migrate = (raw: unknown): Option.Option<unknown> =>
	Option.some({...(raw as Tally), migrated: true});

const tally = (version: string, migrations?: Migrations): AnyProgram =>
	({
		id: TALLY,
		core,
		ports: {},
		handlers: {},
		capabilities: [],
		identity: {package: "@kampus/tuval", program: "tally", version, digest: "sha256:tally"},
		placement: {host: "local"},
		...(migrations === undefined ? {} : {migrations}),
	}) satisfies Program<Tally, Bump, never, never, unknown, never, never>;

const migrations: Migrations = {"1.0.0": {to: "2.0.0", migrate}};
const v1 = tally("1.0.0", migrations);
const v2 = tally("2.0.0", migrations);

describe("a reload that moves only a row's version", () => {
	it("reads as a code change, and so does a migration's `to`", () => {
		assert.strictEqual(codeOf(tally("1.0.0")), codeOf(tally("1.0.0")));
		assert.notStrictEqual(codeOf(v1), codeOf(v2));
		assert.notStrictEqual(
			codeOf(tally("2.0.0", {"1.0.0": {to: "1.5.0", migrate}})),
			codeOf(tally("2.0.0", {"1.0.0": {to: "2.0.0", migrate}})),
		);
	});

	it.live("switches the process, and its state walks the new version's migrations", () =>
		Effect.gen(function* () {
			const processes = yield* Processes;
			const handle = yield* processes.spawn(TALLY, {services: Context.empty()});
			yield* handle.dispatch({type: "bump"});
			yield* handle.dispatch({type: "bump"});
			assert.deepStrictEqual(handle.getState(), {count: 2, migrated: false});

			const applied = yield* applyReload(rowsOnly([v1]), rowsOnly([v2]));

			assert.deepStrictEqual(applied.switched, [handle.id]);
			assert.deepStrictEqual(applied.restoreRefused, []);
			assert.deepStrictEqual(handle.getState(), {count: 2, migrated: true});
		}).pipe(
			Effect.provide(
				Processes.layer.pipe(
					Layer.provideMerge(Registry.layer([v1]).pipe(Layer.orDie)),
					Layer.provide(Checkpoints.layer(memoryStores())),
				),
			),
		),
	);
});
