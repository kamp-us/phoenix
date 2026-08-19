/**
 * The per-feature fate manifest — a feature's whole contribution to the one
 * `FateServer.config` as a single value, so the composition root registers a feature
 * once. See `.patterns/fate-effect-server.md`.
 *
 * Every field is optional, and merge order is not load-bearing: fate's registry is keyed
 * by entry identity and `collectConfigIssues` flags duplicates regardless of order.
 */
import type {
	FateListsRecord,
	FateMutationsRecord,
	FateQueriesRecord,
	FateSourcesList,
} from "@kampus/fate-effect";

/**
 * Annotated `Record<string, unknown>` (never the precise `dataView`/`list` literal) so a
 * feature's `roots` doesn't surface fate's internal `DataView` symbol across its
 * `fateModule` export (TS2883/TS4023).
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
	// Merged into `Root` by `mergeFateRoots` for codegen, NOT threaded into
	// `FateServer.config` — `mergeFateModules` ignores it.
	readonly roots?: FateRootsRecord;
}

type ModuleRecord<M, K extends "queries" | "lists" | "mutations"> = M extends {
	readonly [P in K]: infer R;
}
	? R
	: never;

type MergedRecord<
	Modules extends ReadonlyArray<FateModule>,
	K extends "queries" | "lists" | "mutations",
> = UnionToIntersection<ModuleRecord<Modules[number], K>>;

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

// Typed to the wide base, not the concrete `flatMap` element type: TS2352 fires on a
// direct cast from the concrete result, so this keeps the narrowing to one `as`.
const mergeSources = (modules: ReadonlyArray<FateModule>): FateSourcesList =>
	modules.flatMap((m) => m.sources ?? []);

// Spread, not concat: roots are keyed by resolver name and `collectConfigIssues` already
// pins those for uniqueness, so order is not load-bearing.
export const mergeFateRoots = (modules: ReadonlyArray<FateModule>): FateRootsRecord =>
	Object.assign({}, ...modules.map((m) => m.roots ?? {}));

export const mergeFateModules = <const Modules extends ReadonlyArray<FateModule>>(
	modules: Modules,
): MergedFateConfig<Modules> => ({
	// The runtime spread produces the same value with the wide base type, narrowed once
	// per field — one cast each, the form `no-type-assertions` allows.
	queries: mergeCategory(modules, "queries") as MergedRecord<Modules, "queries">,
	lists: mergeCategory(modules, "lists") as MergedRecord<Modules, "lists">,
	mutations: mergeCategory(modules, "mutations") as MergedRecord<Modules, "mutations">,
	sources: mergeSources(modules) as MergedSources<Modules>,
});
