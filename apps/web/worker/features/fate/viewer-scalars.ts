/**
 * `stampViewerScalars` — the one finalize step that turns a batch-read presence
 * `Set` into a per-row viewer scalar (`myVote` / `isSaved`), replacing the
 * `voteSvc.readMine(...)` + `viewerId ? set.has(id) : null` choreography that was
 * re-inlined verbatim at every list/byIds read site (#1126).
 *
 * The N+1-avoidance contract is now *structural*, not copy-paste: a spec names
 * the field and the batched presence reader once, the helper does the single
 * `IN (...)` read per spec and stamps `viewerId ? set.has(id) : null` uniformly.
 * Anonymous viewer / empty rows short-circuit inside each reader (`readMine`
 * returns an empty Set with no read), so the scalar degrades to `null` and never
 * throws — the read-path convention.
 */
import type {Effect} from "effect";
import {Effect as Eff} from "effect";

/**
 * A viewer scalar to stamp: the wire field it lands on, and the batched presence
 * reader (`Vote.readMine` bound to a kind, `Bookmark.readMine`) that returns the
 * subset of ids the viewer has the row for. The reader owns the
 * missing-viewer/empty short-circuit.
 */
export interface ViewerScalarSpec<F extends string> {
	readonly field: F;
	readonly read: (
		viewerId: string | null | undefined,
		ids: ReadonlyArray<string>,
	) => Effect.Effect<Set<string>>;
}

/**
 * Run every spec's batched presence read once over `rows`' ids, then stamp each
 * named field onto each row as `viewerId ? set.has(row.id) : null`. One read per
 * spec for the whole batch — never per row. The stamped fields are *added* to the
 * input row shape, so a read that wants the scalar must route through here to
 * obtain it (a path that skips the stamp simply never produces the field).
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
