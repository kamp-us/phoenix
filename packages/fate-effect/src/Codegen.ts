/**
 * `toCodegenServer` — the build-time compile surface. The codegen server IS a real fate
 * server (same `createFateServer` call as the live compile, so the client manifest and
 * `InferFateAPI` hold by construction) but every resolver and source executor is INERT:
 * importing the schema module constructs pure data — nothing runs, no database at build time.
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

/** Args are the Schema's ENCODED side — what the client sends before `resolve` decodes. */
export type FateCodegenQueryApi<E> =
	E extends FateQuery<infer D, infer A, infer _E, infer _R>
		? {input: {args?: DefinitionWireArgs<D>; select: Array<string>}; output: A}
		: never;

export type FateCodegenListApi<E> =
	E extends FateList<infer D, infer Item, infer _E, infer _R>
		? {input: {args?: DefinitionWireArgs<D>; select: Array<string>}; output: ConnectionResult<Item>}
		: never;

/** `DefinitionTypeName` keeps `entity` literal — richer than fate's naturally-widened `string`. */
export type FateCodegenMutationApi<E> =
	E extends FateMutation<infer D, infer A, infer _E, infer _R>
		? {entity: DefinitionTypeName<D>; input: DefinitionWireInput<D>; output: A}
		: never;

/**
 * Structurally fate's `NativeFateAPI<{}, Q, L, M>` (empty roots, ADR 0016/0019). `Codegen.test.ts`
 * pins it mutually assignable with fate's own inference over a live reference server.
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

export type FateCodegenServer<
	Q extends FateQueriesRecord,
	L extends FateListsRecord,
	M extends FateMutationsRecord,
> = KernelFateServer<FateCodegenAPI<Q, L, M>, unknown>;

const inertResolve = (category: string, name: string) => (): never => {
	throw new Error(
		`fate codegen server is inert — ${category} "${name}" has no executable handler (build-time schema/manifest only).`,
	);
};

/** `resolve: () => never` satisfies both the query and list shapes, so one helper serves both. */
const inertDefinition = (
	entry: {readonly type: string | undefined},
	category: string,
	name: string,
) => ({
	...(entry.type !== undefined ? {type: entry.type} : {}),
	resolve: inertResolve(category, name),
});

/**
 * Mirrors the live compile step exactly — same record keys, `type` strings, `roots: {}` and
 * live passthrough — so `manifest` matches the live server's. Invalid configs throw the same
 * {@link FateServerConfigError} `FateServer.layer` dies with, surfaced at build time.
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
