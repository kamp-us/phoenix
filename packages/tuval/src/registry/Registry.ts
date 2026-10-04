import {Context, Effect, Layer} from "effect";
import {DuplicateProgramId, ProgramNotFound} from "./errors.ts";
import {type AnyProgram, type ProgramId, provenanceOf} from "./program.ts";

export class Registry extends Context.Service<
	Registry,
	{
		readonly resolve: (id: ProgramId) => Effect.Effect<AnyProgram, ProgramNotFound>;
		readonly list: Effect.Effect<ReadonlyArray<AnyProgram>>;
	}
>()("tuval/Registry") {
	/**
	 * The registry over one list of rows. Building the layer is registration: a duplicate id
	 * fails the layer with `DuplicateProgramId`, naming the id and both rows' provenance.
	 */
	static readonly layer = (
		rows: ReadonlyArray<AnyProgram>,
	): Layer.Layer<Registry, DuplicateProgramId> =>
		Layer.effect(
			Registry,
			Effect.map(register(rows), (rows) => rows.registry),
		);

	/**
	 * The registry over `rows`, beside the `RegistryRows` that adds to it and takes from it. What a
	 * desk that opens and closes projects runs (#9685): a project's rows join when it opens and leave
	 * when it closes, and the registry every spawn resolves through is this one throughout.
	 */
	static readonly growable = (
		rows: ReadonlyArray<AnyProgram>,
	): Layer.Layer<Registry | RegistryRows, DuplicateProgramId> =>
		Layer.effectContext(
			Effect.map(register(rows), ({registry, writer}) =>
				Context.make(Registry, registry).pipe(Context.add(RegistryRows, writer)),
			),
		);
}

/**
 * The write half of a growable registry. A process already running under a removed row keeps
 * running: removal only stops the id resolving, so the caller stops the processes first.
 */
export class RegistryRows extends Context.Service<
	RegistryRows,
	{
		/** Registers every row or none: a duplicate, against the registry or within `rows`, adds nothing. */
		readonly add: (rows: ReadonlyArray<AnyProgram>) => Effect.Effect<void, DuplicateProgramId>;
		/** Unregisters each id. An id the registry does not hold is already gone. */
		readonly remove: (ids: ReadonlyArray<ProgramId>) => Effect.Effect<void>;
	}
>()("tuval/RegistryRows") {}

const duplicateIn = (byId: ReadonlyMap<ProgramId, AnyProgram>, rows: ReadonlyArray<AnyProgram>) => {
	const seen = new Map(byId);
	for (const row of rows) {
		const first = seen.get(row.id);
		if (first !== undefined) {
			return new DuplicateProgramId({
				id: row.id,
				first: provenanceOf(first),
				second: provenanceOf(row),
			});
		}
		seen.set(row.id, row);
	}
	return undefined;
};

const register = Effect.fn("Tuval.Registry.register")(function* (rows: ReadonlyArray<AnyProgram>) {
	const byId = new Map<ProgramId, AnyProgram>();
	const add = (next: ReadonlyArray<AnyProgram>) =>
		Effect.suspend(() => {
			const duplicate = duplicateIn(byId, next);
			if (duplicate !== undefined) return Effect.fail(duplicate);
			for (const row of next) byId.set(row.id, row);
			return Effect.void;
		});
	yield* add(rows);
	const registry = Registry.of({
		resolve: (id) =>
			Effect.suspend(() => {
				const row = byId.get(id);
				return row === undefined ? Effect.fail(new ProgramNotFound({id})) : Effect.succeed(row);
			}),
		list: Effect.sync(() => [...byId.values()]),
	});
	const writer = RegistryRows.of({
		add,
		remove: (ids) =>
			Effect.sync(() => {
				for (const id of ids) byId.delete(id);
			}),
	});
	return {registry, writer};
});
