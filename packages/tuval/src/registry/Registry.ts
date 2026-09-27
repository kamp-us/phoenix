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
	): Layer.Layer<Registry, DuplicateProgramId> => Layer.effect(Registry, register(rows));
}

const register = Effect.fn("Tuval.Registry.register")(function* (rows: ReadonlyArray<AnyProgram>) {
	const byId = new Map<ProgramId, AnyProgram>();
	for (const row of rows) {
		const first = byId.get(row.id);
		if (first !== undefined) {
			return yield* new DuplicateProgramId({
				id: row.id,
				first: provenanceOf(first),
				second: provenanceOf(row),
			});
		}
		byId.set(row.id, row);
	}
	return Registry.of({
		resolve: (id) => {
			const row = byId.get(id);
			return row === undefined ? Effect.fail(new ProgramNotFound({id})) : Effect.succeed(row);
		},
		list: Effect.succeed([...byId.values()]),
	});
});
