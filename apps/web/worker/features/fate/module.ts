/**
 * The per-feature fate manifest — a feature's whole contribution to the one
 * `FateServer.config` as a single value, so the composition root registers a
 * feature once (`config.ts`'s `modules` array) instead of threading it through a
 * separate barrel per operation category. See `.patterns/fate-effect-server.md`.
 *
 * Every field is optional: a feature contributes only the categories it has
 * (stats is queries-only, search is lists-only). `mergeFateModules` is generic
 * over the modules tuple so the merged value keeps each entry's precise type —
 * the `FateServer.config` R-channel math (`FateServerRequirements`) is inferred
 * exactly as it was from the hand-written barrels. Order is not load-bearing
 * (fate's registry is keyed by entry identity, and `collectConfigIssues` flags
 * duplicates regardless of order), so the merge resolves identically.
 */
import type {
	FateListsRecord,
	FateMutationsRecord,
	FateQueriesRecord,
	FateSourcesList,
} from "@kampus/fate-effect";

/**
 * The client-exposed root map a feature contributes — its slice of `fate/views.ts`'s
 * `Root`. Annotated `Record<string, unknown>` (never the precise `dataView`/`list`
 * literal) so a feature's `roots` doesn't surface fate's internal `DataView` symbol
 * across its `fateModule` export (TS2883/TS4023), matching `Root`'s own annotation.
 */
export type FateRootsRecord = Record<string, unknown>;

export interface FateModule<
	Q extends FateQueriesRecord = FateQueriesRecord,
	L extends FateListsRecord = FateListsRecord,
	M extends FateMutationsRecord = FateMutationsRecord,
	S extends FateSourcesList = FateSourcesList,
> {
	readonly queries?: Q;
	readonly lists?: L;
	readonly mutations?: M;
	readonly sources?: S;
	// The feature's client roots. Merged into `Root` by `mergeFateRoots` for codegen,
	// NOT threaded into `FateServer.config` (`mergeFateModules` ignores it — `roots`
	// stays empty on `createFateServer`, see `views.ts`).
	readonly roots?: FateRootsRecord;
}

/** One module's record for category `K`, or `never` if it omits that category. */
type ModuleRecord<M, K extends "queries" | "lists" | "mutations"> = M extends {
	readonly [P in K]: infer R;
}
	? R
	: never;

/** Intersect one category across the modules tuple (records merge by spread). */
type MergedRecord<
	Modules extends ReadonlyArray<FateModule>,
	K extends "queries" | "lists" | "mutations",
> = UnionToIntersection<ModuleRecord<Modules[number], K>>;

/** Union of every module's source-element types (sources concatenate). */
type SourceElement<M> = M extends {readonly sources: infer S}
	? S extends ReadonlyArray<infer E>
		? E
		: never
	: never;
type MergedSources<Modules extends ReadonlyArray<FateModule>> = ReadonlyArray<
	SourceElement<Modules[number]>
>;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
	k: infer I,
) => void
	? I
	: never;

export interface MergedFateConfig<Modules extends ReadonlyArray<FateModule>> {
	readonly queries: MergedRecord<Modules, "queries">;
	readonly lists: MergedRecord<Modules, "lists">;
	readonly mutations: MergedRecord<Modules, "mutations">;
	readonly sources: MergedSources<Modules>;
}

const mergeCategory = (
	modules: ReadonlyArray<FateModule>,
	key: "queries" | "lists" | "mutations",
) => Object.assign({}, ...modules.map((m) => m[key] ?? {}));

// Typed to the wide base (`FateSourcesList`) — not the concrete `flatMap` element
// type — so the per-call narrowing to `MergedSources<Modules>` overlaps in one
// `as`, matching the three category casts and staying single-cast (TS2352 would
// fire on a direct cast from the concrete `flatMap` result; see `no-type-assertions`).
const mergeSources = (modules: ReadonlyArray<FateModule>): FateSourcesList =>
	modules.flatMap((m) => m.sources ?? []);

// `Root` is the cross-feature client-root map (`createSchema(views, Root)`); each
// feature owns its slice on its `fateModule`, so registering a feature in `config.ts`'s
// `modules` array is the single source that drives both the served config and `Root`.
// Spread (not concat) — a feature's roots are keyed by their resolver names, which
// `collectConfigIssues` already pins for uniqueness, so order is not load-bearing.
export const mergeFateRoots = (modules: ReadonlyArray<FateModule>): FateRootsRecord =>
	Object.assign({}, ...modules.map((m) => m.roots ?? {}));

export const mergeFateModules = <const Modules extends ReadonlyArray<FateModule>>(
	modules: Modules,
): MergedFateConfig<Modules> => ({
	// Each merged field's precise type is recovered structurally by the type
	// params (`MergedRecord`/`MergedSources`); the runtime spread/concat below
	// produces the same value with the wide base type, narrowed once per field —
	// a single narrowing cast, the form code review owns (`no-type-assertions`).
	queries: mergeCategory(modules, "queries") as MergedRecord<Modules, "queries">,
	lists: mergeCategory(modules, "lists") as MergedRecord<Modules, "lists">,
	mutations: mergeCategory(modules, "mutations") as MergedRecord<Modules, "mutations">,
	sources: mergeSources(modules) as MergedSources<Modules>,
});
