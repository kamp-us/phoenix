/**
 * The set's one-value invariant, tested where it can actually break: under two writers at once
 * (#7752).
 *
 * Every assertion here is about a *generation* — a table, the binding sources compiled against it,
 * and the result of that compile. A binding is only as valid as the table it was compiled against,
 * so a state whose `bindings` are not what a fresh compile of its own `table` and `keys` produces
 * is a state no reader may ever see. `recompile` below is the oracle for that: it is `compileAll`'s
 * shape written out again, so a failure names a real disagreement rather than a shared bug.
 *
 * A generation here carries `BINDINGS_PER_SOURCE` bindings rather than one, and that number is
 * load-bearing rather than thoroughness: a compile short enough to finish inside one fiber's
 * operation budget is never preempted, and a race nothing interleaves proves nothing. The budget is
 * `Scheduler.MaxOpsBeforeYield`, 2048 by default at this pin, so a compile of this size spans
 * several yields and a second writer always gets its window.
 */

import {Effect, Schema} from "effect";
import {describe, expect, it} from "vitest";
import {type BindingSource, type CompiledBindings, compileBindings} from "./bindings/index.ts";
import {buildRegistry, type RegistryTable, SpellRegistry} from "./registry.ts";
import {type AnySpell, defineSpell, renderPath, type SpellPath} from "./spell.ts";
import {SpellSet, type SpellSetInput, type SpellSetState} from "./spell-set.ts";

const spell = (path: SpellPath): AnySpell =>
	defineSpell({
		path,
		describe: `Run ${renderPath(path)}.`,
		params: Schema.Struct({}),
		result: Schema.Void,
		execute: () => Effect.void,
		capabilities: [],
	});

const BINDINGS_PER_SOURCE = 400;

/**
 * One config generation: a table holding exactly `window <name>`, and a source whose every binding
 * names it. A source only compiles against its own generation's table — against any other every
 * binding becomes a `BindingError` — so the pair a state carries is readable off the state.
 */
const generation = (name: string) => {
	const keys = Array.from({length: BINDINGS_PER_SOURCE}, (_, index) => `ctrl+${name}-${index}`);
	const source: BindingSource = {
		file: `${name}.config.ts`,
		bindings: Object.fromEntries(keys.map((key) => [key, `window ${name}`])),
	};
	return {
		name,
		keys,
		source,
		path: `window.${name}`,
		input: {
			core: [spell(["window", name])],
			programs: [],
			keys: [source],
		} satisfies SpellSetInput,
	};
};

const gen0 = generation("close");
const gen1 = generation("open");
const genA = generation("grow");
const genB = generation("shrink");

const tableOf = (of: {readonly input: SpellSetInput}): Effect.Effect<RegistryTable> =>
	buildRegistry({core: of.input.core, programs: of.input.programs}).pipe(Effect.orDie);

/** `compileAll`'s answer, computed again from outside — the oracle a state is checked against. */
const recompile = (
	table: RegistryTable,
	keys: ReadonlyArray<BindingSource>,
): Effect.Effect<CompiledBindings> =>
	Effect.map(
		Effect.forEach(keys, (source) => compileBindings(source, table), {concurrency: 1}),
		(compiled) => ({
			bindings: compiled.flatMap((one) => one.bindings),
			errors: compiled.flatMap((one) => one.errors),
		}),
	);

const paths = (table: RegistryTable): ReadonlyArray<string> =>
	table.rows.map((row) => renderPath(row.path));

/** Which generation's sources a state carries — the axis a lost update shows up on. */
const keysOf = (state: SpellSetState): ReadonlyArray<string> =>
	state.keys.map((source) => source.file);

/** The keys a binding actually fired, so a mixed generation reads as an empty list. */
const boundKeys = (state: SpellSetState): ReadonlyArray<string> =>
	state.bindings.bindings.map((binding) => binding.key);

const withSet = <A, E>(
	input: SpellSetInput,
	body: (services: {
		readonly set: SpellSet["Service"];
		readonly registry: SpellRegistry["Service"];
	}) => Effect.Effect<A, E>,
): Promise<A> =>
	Effect.runPromise(
		Effect.all({set: SpellSet, registry: SpellRegistry}, {concurrency: 1}).pipe(
			Effect.flatMap(body),
			Effect.provide(SpellSet.layer(input)),
			Effect.orDie,
		),
	);

/**
 * The transitions in an observation run: a state identical by reference to the one before it is
 * the same read twice. Only a *consecutive* repeat is dropped, because a state returning after
 * another one stood is the walk-back these tests are looking for.
 */
const distinct = (states: ReadonlyArray<SpellSetState>): ReadonlyArray<SpellSetState> =>
	states.filter((state, index) => state !== states[index - 1]);

/** Fails unless a state's bindings are what its own table and sources compile to. */
const expectWhole = (state: SpellSetState): Promise<void> =>
	Effect.runPromise(
		Effect.map(recompile(state.table, state.keys), (fresh) => {
			expect(state.bindings).toEqual(fresh);
		}),
	);

describe("SpellSet.read", () => {
	it("returns the table, its sources and their bindings as one generation", async () => {
		const state = await withSet(gen0.input, ({set}) => set.read);
		await expectWhole(state);
		expect(paths(state.table)).toEqual([gen0.path]);
		expect(keysOf(state)).toEqual([gen0.source.file]);
		expect(boundKeys(state)).toEqual(gen0.keys);
	});

	it("never returns a table beside bindings compiled from another generation", async () => {
		const seen = await withSet(gen0.input, ({set}) =>
			Effect.gen(function* () {
				const observations: Array<SpellSetState> = [];
				const read = Effect.gen(function* () {
					for (let round = 0; round < 200; round++) {
						observations.push(yield* set.read);
						yield* Effect.yieldNow;
					}
				});
				yield* Effect.all([read, read, set.reload(gen1.input)], {concurrency: "unbounded"});
				return observations;
			}),
		);

		for (const state of distinct(seen)) {
			await expectWhole(state);
			// A generation is the pair, so both halves must name the same one and every binding it
			// declares must have compiled — a table beside another generation's source compiles to
			// no bindings at all.
			const which = keysOf(state).at(0) === gen0.source.file ? gen0 : gen1;
			expect(paths(state.table)).toEqual([which.path]);
			expect(boundKeys(state)).toEqual(which.keys);
		}
		expect(keysOf(seen[0] as SpellSetState)).toEqual([gen0.source.file]);
		expect(keysOf(seen.at(-1) as SpellSetState)).toEqual([gen1.source.file]);
	});
});

describe("SpellSet.reload", () => {
	it("installs the fresh table and the freshly compiled bindings together", async () => {
		const [before, after] = await withSet(gen0.input, ({set}) =>
			Effect.gen(function* () {
				const first = yield* set.read;
				yield* set.reload(gen1.input);
				return [first, yield* set.read] as const;
			}),
		);

		expect(paths(before.table)).toEqual([gen0.path]);
		expect(boundKeys(before)).toEqual(gen0.keys);
		expect(paths(after.table)).toEqual([gen1.path]);
		expect(keysOf(after)).toEqual([gen1.source.file]);
		expect(boundKeys(after)).toEqual(gen1.keys);
		await expectWhole(after);
	});
});

describe("SpellRegistry over the set", () => {
	it("reads the installed generation after a reload", async () => {
		const answers = await withSet(gen0.input, ({set, registry}) =>
			Effect.gen(function* () {
				const missing = yield* Effect.flip(registry.lookup(["window", gen1.name]));
				yield* set.reload(gen1.input);
				return {
					missing: missing.path,
					found: renderPath((yield* registry.lookup(["window", gen1.name])).path),
					gone: (yield* Effect.flip(registry.lookup(["window", gen0.name]))).path,
					listed: (yield* registry.list).map((row) => renderPath(row.path)),
					described: (yield* registry.describe).map((one) => one.path.join(".")),
				};
			}),
		);

		expect(answers.missing).toBe(gen1.path);
		expect(answers.found).toBe(gen1.path);
		expect(answers.gone).toBe(gen0.path);
		expect(answers.listed).toEqual([gen1.path]);
		expect(answers.described).toEqual([gen1.path]);
	});

	it("loses no update when two swaps and a reload race", async () => {
		const tableA = await Effect.runPromise(tableOf(genA));
		const tableB = await Effect.runPromise(tableOf(genB));

		const {observations, final} = await withSet(gen0.input, ({set, registry}) =>
			Effect.gen(function* () {
				const seen: Array<SpellSetState> = [];
				const read = Effect.gen(function* () {
					for (let round = 0; round < 200; round++) {
						seen.push(yield* set.read);
						yield* Effect.yieldNow;
					}
				});
				// The reload goes first on purpose. `swap` carries the sources forward, so the only
				// update it can drop belongs to a writer that changes them, and it drops that one
				// only by reading before that write and storing after it. Starting the reload ahead
				// of the swaps puts its write inside their compiles, which is that window exactly.
				yield* Effect.all(
					[set.reload(gen1.input), registry.swap(tableA), registry.swap(tableB), read],
					{concurrency: "unbounded"},
				);
				return {observations: seen, final: yield* set.read};
			}),
		);

		expect(keysOf(final)).toEqual([gen1.source.file]);
		await expectWhole(final);
		expect([[genA.path], [genB.path], [gen1.path]]).toContainEqual(paths(final.table));

		// No reader ever walks back either: once the reload's sources are installed nothing
		// reinstates the generation they replaced, and every state on the way is whole.
		let reloaded = false;
		for (const state of distinct(observations)) {
			await expectWhole(state);
			const isReloaded = keysOf(state).at(0) === gen1.source.file;
			expect(isReloaded || !reloaded).toBe(true);
			reloaded ||= isReloaded;
		}
		expect(reloaded).toBe(true);
	});
});
