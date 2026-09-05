/**
 * The registered spells and the key bindings compiled against them, held in one cell and replaced
 * in one write (#7645).
 *
 * A binding is only ever as valid as the table it was compiled against, so the two are not two
 * pieces of state that a reload has to remember to update together: they are one value. Every
 * write goes through `install`, which compiles the bindings against the table it is about to
 * store, so a reader can never see a new table beside bindings compiled against the old one.
 *
 * The `SpellRegistry` this module's layer provides reads that same cell, which is why the layer
 * hands out both services: two cells would be two states to keep in step, and keeping them in step
 * is the whole job.
 */

import {Context, Effect, Layer, SynchronizedRef} from "effect";
import type {AnyProgram} from "../registry/program.ts";
import {type BindingSource, type CompiledBindings, compileBindings} from "./bindings/index.ts";
import {type DuplicateSpellPath, type SpellNotDescribable, SpellNotFound} from "./errors.ts";
import {
	buildRegistry,
	describeSpell,
	lookupRow,
	type RegistryTable,
	SpellRegistry,
} from "./registry.ts";
import {type AnySpell, renderPath} from "./spell.ts";

/** What one config produces: the spells its programs declare, and the keys they are bound to. */
export interface SpellSetInput {
	/** The spells the kernel itself registers, under no program id. */
	readonly core: ReadonlyArray<AnySpell>;
	readonly programs: ReadonlyArray<AnyProgram>;
	/** One source per config layer, so a binding error names the module its author wrote it in. */
	readonly keys: ReadonlyArray<BindingSource>;
}

/** The whole state, read in one go: the table, the sources it was compiled from, and the result. */
export interface SpellSetState {
	readonly table: RegistryTable;
	readonly keys: ReadonlyArray<BindingSource>;
	readonly bindings: CompiledBindings;
}

/**
 * Every layer's bindings against one table, in layer order. A later layer's binding for a key a
 * lower layer also bound wins the same way its program row does, because it comes later in the
 * list a key router reads.
 */
const compileAll = Effect.fn("Tuval.SpellSet.compileAll")(function* (
	table: RegistryTable,
	keys: ReadonlyArray<BindingSource>,
) {
	const bindings: Array<CompiledBindings["bindings"][number]> = [];
	const errors: Array<CompiledBindings["errors"][number]> = [];
	for (const source of keys) {
		const compiled = yield* compileBindings(source, table);
		bindings.push(...compiled.bindings);
		errors.push(...compiled.errors);
	}
	return {bindings, errors} satisfies CompiledBindings;
});

const make = Effect.fn("Tuval.SpellSet.make")(function* (input: SpellSetInput) {
	const build = Effect.fn("Tuval.SpellSet.build")(function* (
		table: RegistryTable,
		keys: ReadonlyArray<BindingSource>,
	) {
		return {table, keys, bindings: yield* compileAll(table, keys)} satisfies SpellSetState;
	});

	const initial = yield* build(
		yield* buildRegistry({core: input.core, programs: input.programs}),
		input.keys,
	);
	// One cell, so the single write in `install` is the only way either half changes and a reader's
	// single read sees both halves of one config. It is a `SynchronizedRef` so an update that
	// has to compile first can hold the cell while it does.
	const cell = yield* SynchronizedRef.make<SpellSetState>(initial);
	const install = (state: SpellSetState) => SynchronizedRef.set(cell, state);

	const registry = SpellRegistry.of({
		lookup: (path) =>
			Effect.flatMap(SynchronizedRef.get(cell), (state) => {
				const row = lookupRow(state.table, path);
				return row === undefined
					? Effect.fail(new SpellNotFound({path: renderPath(path)}))
					: Effect.succeed(row);
			}),
		list: Effect.map(SynchronizedRef.get(cell), (state) => state.table.rows),
		describe: Effect.map(SynchronizedRef.get(cell), (state) => state.table.rows.map(describeSpell)),
		// The registry's own `swap` recompiles the bindings against the table it is installing, so
		// even this narrower entry cannot leave the two halves disagreeing.
		// `SynchronizedRef.updateEffect` holds the cell's semaphore across the compile, so this is
		// one write and not a read, a compile and a later write a concurrent reload could land
		// inside (#7752).
		swap: (table) => SynchronizedRef.updateEffect(cell, (state) => build(table, state.keys)),
	});

	const set = SpellSet.of({
		read: SynchronizedRef.get(cell),
		reload: Effect.fn("Tuval.SpellSet.reload")(function* (next: SpellSetInput) {
			const table = yield* buildRegistry({core: next.core, programs: next.programs});
			yield* install(yield* build(table, next.keys));
		}),
	});

	return Context.make(SpellSet, set).pipe(Context.add(SpellRegistry, registry));
});

export class SpellSet extends Context.Service<
	SpellSet,
	{
		/** The table, its key sources and their compiled bindings, as one value. */
		readonly read: Effect.Effect<SpellSetState>;
		/** A reloaded config: a fresh table and fresh bindings, installed in one write. */
		readonly reload: (
			input: SpellSetInput,
		) => Effect.Effect<void, DuplicateSpellPath | SpellNotDescribable>;
	}
>()("tuval/SpellSet") {
	/**
	 * The set and the `SpellRegistry` over it. Both come from one layer because both read one cell;
	 * `SpellRegistry.layer` builds a registry over a cell of its own and stays the seam for a test
	 * that has no bindings to keep in step.
	 */
	static readonly layer = (
		input: SpellSetInput,
	): Layer.Layer<SpellSet | SpellRegistry, DuplicateSpellPath | SpellNotDescribable> =>
		Layer.effectContext(make(input));
}
