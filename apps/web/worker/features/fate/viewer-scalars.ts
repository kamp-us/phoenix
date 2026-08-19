/**
 * Turns a batch-read presence `Set` into a per-row viewer scalar (`myVote` / `isSaved`),
 * making the N+1-avoidance contract structural rather than copy-paste (#1126). An
 * anonymous viewer degrades the scalar to `null` and never throws.
 */
import type {Effect} from "effect";
import {Effect as Eff} from "effect";

/** The `read` reader owns the missing-viewer / empty-ids short-circuit. */
export interface ViewerScalarSpec<F extends string> {
	readonly field: F;
	readonly read: (
		viewerId: string | null | undefined,
		ids: ReadonlyArray<string>,
	) => Effect.Effect<Set<string>>;
}

/**
 * One read per spec for the WHOLE batch, never per row. The stamped fields are added to
 * the input row shape, so a path that skips this helper simply never produces them.
 */
export const stampViewerScalars = <R extends {id: string}, F extends string>(
	rows: ReadonlyArray<R>,
	viewerId: string | null | undefined,
	specs: ReadonlyArray<ViewerScalarSpec<F>>,
): Effect.Effect<Array<R & {[K in F]: boolean | null}>> =>
	Eff.gen(function* () {
		const ids = rows.map((row) => row.id);
		const sets = yield* Eff.forEach(specs, (spec) => spec.read(viewerId, ids));
		return rows.map((row) => {
			const scalars: Record<string, boolean | null> = {};
			specs.forEach((spec, i) => {
				scalars[spec.field] = viewerId ? (sets[i]?.has(row.id) ?? false) : null;
			});
			return {...row, ...scalars} as R & {[K in F]: boolean | null};
		});
	});
