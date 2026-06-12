/**
 * `toCodegenServer` — the BUILD-TIME compile surface, split out of
 * `Executor.ts`: this module is the PRODUCTION build path —
 * `schema.ts` exports its value for Vite codegen on every deploy — while
 * `Executor.ts` keeps only the frozen oracle baseline. The two share the
 * compiled-definition vocabulary through `Compiled.ts` and never import each
 * other; the public `FateExecutor.toCodegenServer` spelling is assembled in
 * the barrel (`index.ts`).
 *
 * The codegen server IS a real fate server — same `createFateServer` call as
 * the live compile, so the client manifest and `InferFateAPI` hold by
 * construction — but every resolver and source executor is INERT: importing
 * the schema module constructs pure data (nothing runs, no database at build
 * time).
 */
import type {ConnectionResult, FateServer as KernelFateServer} from "@nkzw/fate/server";
import {createFateServer} from "@nkzw/fate/server";
import type {
	CompiledListDefinition,
	CompiledMutationDefinition,
	CompiledQueryDefinition,
} from "./Compiled.ts";
import {buildSourceResolver, mapRecord, mutationWireType} from "./Compiled.ts";
import type {
	DefinitionTypeName,
	DefinitionWireArgs,
	DefinitionWireInput,
	FateList,
	FateMutation,
	FateQuery,
} from "./Operation.ts";
import type {FateRequestContext} from "./RequestContext.ts";
import type {
	AnyFateServerConfig,
	FateListsRecord,
	FateMutationsRecord,
	FateQueriesRecord,
	FateServerConfig,
	FateSourcesList,
} from "./Server.ts";
import {collectConfigIssues, FateServerConfigError} from "./Server.ts";

/**
 * What `InferFateAPI` must yield for one config QUERY entry — fate's own
 * `QueryAPI` mapping reproduced over the package's entry types: a
 * `Fate.query` entry surfaces the definition's WIRE args (the Schema's
 * ENCODED side — what the client sends before `resolve` decodes) and the
 * handler's success type. A non-entry maps to `never`, exactly as fate's
 * `QueryAPI` does for an uninferrable record.
 */
export type FateCodegenQueryApi<E> =
	E extends FateQuery<infer D, infer A, infer _E, infer _R>
		? {input: {args?: DefinitionWireArgs<D>; select: Array<string>}; output: A}
		: never;

/** As {@link FateCodegenQueryApi}, with fate's `ConnectionResult` envelope. */
export type FateCodegenListApi<E> =
	E extends FateList<infer D, infer Item, infer _E, infer _R>
		? {input: {args?: DefinitionWireArgs<D>; select: Array<string>}; output: ConnectionResult<Item>}
		: never;

/**
 * As {@link FateCodegenQueryApi}, for mutations: `entity` is the definition's
 * literal wire type name (`DefinitionTypeName` keeps it literal — richer than
 * fate's naturally-widened `string`, and what `MutationAPI` reads from the
 * record's `type` property), `input` is the WIRE input.
 */
export type FateCodegenMutationApi<E> =
	E extends FateMutation<infer D, infer A, infer _E, infer _R>
		? {entity: DefinitionTypeName<D>; input: DefinitionWireInput<D>; output: A}
		: never;

/**
 * The full `InferFateAPI` surface of a codegen server — structurally fate's
 * `NativeFateAPI<{}, Q, L, M>` (empty roots, ADR 0016/0019) computed from the
 * TYPED config records. `Codegen.test.ts` pins it mutually assignable with
 * fate's own inference over a live reference server.
 */
export interface FateCodegenAPI<
	Q extends FateQueriesRecord,
	L extends FateListsRecord,
	M extends FateMutationsRecord,
> {
	readonly lists: {readonly [K in keyof L]: FateCodegenListApi<L[K]>};
	readonly mutations: {readonly [K in keyof M]: FateCodegenMutationApi<M[K]>};
	readonly queries: {readonly [K in keyof Q]: FateCodegenQueryApi<Q[K]>};
}

/**
 * What {@link toCodegenServer} returns: fate's server value carrying the
 * config-derived API as its `__api` phantom — the type `InferFateAPI` plucks
 * in the generated client.
 */
export type FateCodegenServer<
	Q extends FateQueriesRecord,
	L extends FateListsRecord,
	M extends FateMutationsRecord,
> = KernelFateServer<FateCodegenAPI<Q, L, M>, unknown>;

/** An inert resolver: the codegen server is schema/manifest only, never serves. */
const inertResolve = (category: string, name: string) => (): never => {
	throw new Error(
		`fate codegen server is inert — ${category} "${name}" has no executable handler (build-time schema/manifest only).`,
	);
};

/**
 * An inert definition: the entry's `type` passed through, nothing executable.
 * The inferred `resolve: () => never` satisfies both the query and list
 * definition shapes, so one helper serves both categories.
 */
const inertDefinition = (
	entry: {readonly type: string | undefined},
	category: string,
	name: string,
) => ({
	...(entry.type !== undefined ? {type: entry.type} : {}),
	resolve: inertResolve(category, name),
});

/**
 * Build the CODEGEN server from a typed config: the same `createFateServer`
 * call the live compile step makes — same record keys, same `type` strings,
 * same `roots: {}`, same live option passthrough, so `manifest` matches the
 * live server's — but every resolver and source executor is INERT. `schema.ts`
 * exports this value for the fate Vite plugin's `runnerImport`: importing it
 * constructs pure data (nothing runs, no database at build time), and its
 * declared type carries {@link FateCodegenAPI}, so
 * `InferFateAPI<typeof fateServer>` in the generated client matches the live
 * wire contract (pinned in `Codegen.test.ts`).
 *
 * Invalid configs throw {@link FateServerConfigError} here — the same issues
 * `FateServer.layer` dies with at worker init, surfaced at build time.
 */
export function toCodegenServer<
	Q extends FateQueriesRecord,
	L extends FateListsRecord,
	M extends FateMutationsRecord,
	S extends FateSourcesList,
>(config: FateServerConfig<Q, L, M, S>): FateCodegenServer<Q, L, M>;
export function toCodegenServer(config: AnyFateServerConfig): KernelFateServer<unknown, unknown> {
	const issues = collectConfigIssues(config);
	if (issues.length > 0) {
		throw new FateServerConfigError(issues);
	}
	return createFateServer<
		FateRequestContext,
		Record<never, never>,
		Record<string, CompiledQueryDefinition>,
		Record<string, CompiledListDefinition>,
		Record<string, CompiledMutationDefinition>,
		unknown
	>({
		// No `context` factory: the codegen server never handles a real request;
		// an executed operation hits an inert resolver and fails closed.
		roots: {},
		queries: mapRecord(config.queries, (entry, name) => inertDefinition(entry, "query", name)),
		lists: mapRecord(config.lists, (entry, name) => inertDefinition(entry, "list", name)),
		// The validated-config invariant narrows the mutation's wire type
		// (`mutationWireType`, Compiled.ts) — `collectConfigIssues` above
		// already rejected any typeless mutation.
		mutations: mapRecord(config.mutations, (entry, name) => ({
			type: mutationWireType(name, entry),
			resolve: inertResolve("mutation", name),
		})),
		// The identity-keyed registry with EMPTY executors: same definitions
		// (manifest/schema parity), no capabilities to run.
		sources: buildSourceResolver(config.sources, () => ({})),
		...(config.live !== undefined ? {live: config.live} : {}),
	});
}
