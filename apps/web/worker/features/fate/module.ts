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
	sources: modules.flatMap((m) => m.sources ?? []) as MergedSources<Modules>,
});
