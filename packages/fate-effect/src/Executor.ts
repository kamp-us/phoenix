/**
 * The v1 compile step — a validated `FateServer` service → a pure
 * `createFateServer` call.
 *
 * Since the v2 cutover (ADR 0043) this no longer serves `/fate`; its one
 * consumer is the differential oracle's baseline, so it stays frozen exactly
 * as it served. See .patterns/fate-effect-compiler.md.
 */
import type {FateServer as KernelFateServer} from "@nkzw/fate/server";
import {createFateServer} from "@nkzw/fate/server";
import {Context, Effect, Exit, type ManagedRuntime} from "effect";
import type {
	AnyRow,
	CompiledArgsInput,
	CompiledFateSources,
	CompiledListDefinition,
	CompiledMutationDefinition,
	CompiledQueryDefinition,
	CompiledResolverOptions,
	KernelSourceExecutor,
} from "./Compiled.ts";
import {buildSourceResolver, mapRecord, mutationWireType} from "./Compiled.ts";
import type {RawArgsInput} from "./Operation.ts";
import {provideRequestPair} from "./Provision.ts";
import type {FateRequestContext} from "./RequestContext.ts";
import type {
	AnyFateMutation,
	AnyFateSourceHandlers,
	FateServerService,
	FateSourcesList,
} from "./Server.ts";
import {FateServer} from "./Server.ts";
import {encodeWireError, failureOf} from "./WireError.ts";

/**
 * One runtime per isolate, never disposed on CF — ADR 0041. Contravariant in
 * R, so a runtime carrying more services than `FateServer` satisfies this.
 */
export type FateExecutorRuntime = ManagedRuntime.ManagedRuntime<FateServer, never>;

/**
 * `signal` is executor-local on purpose: the served contract must carry no
 * abort knob (the worker route wires abort→interruption at the edge, ADR
 * 0043), and this `runPromise` path is the only place one exists.
 */
export interface ExecutorRequestContext extends FateRequestContext {
	readonly signal?: AbortSignal;
}

export type CompiledFateServer = KernelFateServer<unknown, ExecutorRequestContext>;

export type FateFetchHandler = (
	request: Request,
	context: ExecutorRequestContext,
) => Promise<Response>;

interface CompileOptions {
	readonly runtime: FateExecutorRuntime;
	readonly services: Context.Context<never>;
}

/**
 * The throw is the contract: fate's `executeOperation` catches it and
 * serializes `{ok: false, error: {code, message}}`.
 */
const runResolve = <A>(
	options: CompileOptions,
	ctx: ExecutorRequestContext,
	effect: Effect.Effect<A, unknown, unknown>,
): Promise<A> =>
	options.runtime
		.runPromise(Effect.exit(provideRequestPair(ctx, options.services)(effect)), {
			signal: ctx.signal,
		})
		.then((exit) => {
			if (Exit.isSuccess(exit)) {
				return exit.value;
			}
			throw encodeWireError(failureOf(exit.cause));
		});

const adaptArgsEntry = <A>(
	options: CompileOptions,
	entry: {
		readonly type: string | undefined;
		readonly resolve: (input: RawArgsInput) => Effect.Effect<A, unknown, unknown>;
	},
): {
	readonly type?: string;
	readonly resolve: (options: CompiledResolverOptions<CompiledArgsInput>) => Promise<A>;
} => ({
	...(entry.type !== undefined ? {type: entry.type} : {}),
	resolve: ({ctx, input, select}) =>
		runResolve(options, ctx, entry.resolve({args: input.args, select})),
});

const adaptMutation = (
	options: CompileOptions,
	name: string,
	entry: AnyFateMutation,
): CompiledMutationDefinition => ({
	// The validated-config invariant narrows the erased `string | undefined`
	// (`mutationWireType`, Compiled.ts) — the config-error check itself lives
	// in `collectConfigIssues`.
	type: mutationWireType(name, entry),
	resolve: ({ctx, input, select}) => runResolve(options, ctx, entry.resolve({input, select})),
});

const adaptSourceHandlers = (
	options: CompileOptions,
	handlers: AnyFateSourceHandlers,
): KernelSourceExecutor => {
	const {byId, byIds, connection} = handlers;
	// One literal with conditional spreads: under `exactOptionalPropertyTypes`,
	// assigning to declared-optional fields would widen them to `… | undefined`.
	return {
		...(byId
			? {
					byId: ({ctx, id}: {ctx: ExecutorRequestContext; id: string}) =>
						runResolve(options, ctx, byId(id)),
				}
			: {}),
		...(byIds
			? {
					byIds: ({ctx, ids}: {ctx: ExecutorRequestContext; ids: Array<string>}) =>
						runResolve(options, ctx, byIds(ids)).then((rows) => [...rows]),
				}
			: {}),
		...(connection
			? {
					connection: ({
						ctx,
						cursor,
						direction,
						take,
						skip,
						plan,
					}: {
						ctx: ExecutorRequestContext;
						cursor?: string;
						direction: "backward" | "forward";
						take: number;
						skip?: number;
						plan?: {args?: AnyRow};
					}) =>
						runResolve(
							options,
							ctx,
							connection({
								direction,
								take,
								...(plan?.args !== undefined ? {args: plan.args} : {}),
								...(cursor !== undefined ? {cursor} : {}),
								...(skip !== undefined ? {skip} : {}),
							}),
						).then((rows) => [...rows]),
				}
			: {}),
	};
};

export const compileFateSources = (
	sources: FateSourcesList,
	options: CompileOptions,
): CompiledFateSources =>
	buildSourceResolver(sources, (entry) => adaptSourceHandlers(options, entry.handlers));

export const compile = (
	service: FateServerService,
	runtime: FateExecutorRuntime,
): CompiledFateServer => {
	const options: CompileOptions = {runtime, services: service.services};
	return createFateServer<
		ExecutorRequestContext,
		Record<never, never>,
		Record<string, CompiledQueryDefinition>,
		Record<string, CompiledListDefinition>,
		Record<string, CompiledMutationDefinition>,
		ExecutorRequestContext
	>({
		// The fetch handler always supplies the per-request context (fate types
		// adapterContext optional); read it through, asserting its presence. The
		// SAME object becomes every resolver's ctx (identity, never a copy).
		context: ({adapterContext}) => {
			if (!adapterContext) {
				throw new Error(
					"fate adapterContext missing — the fetch handler must supply the per-request context.",
				);
			}
			return adapterContext;
		},
		// `roots` stays empty (ADR 0016/0019: every read is a custom resolver;
		// root views are a codegen-side concern, not a server option here).
		roots: {},
		queries: mapRecord(service.queries, (entry) => adaptArgsEntry(options, entry)),
		lists: mapRecord(service.lists, (entry) => adaptArgsEntry(options, entry)),
		mutations: mapRecord(service.mutations, (entry, name) => adaptMutation(options, name, entry)),
		sources: compileFateSources(service.sources, options),
		// fate types `live?: false | LiveConfig` — an omitted config key stays
		// omitted (exactOptionalPropertyTypes), it does not become `undefined`.
		...(service.live !== undefined ? {live: service.live} : {}),
	});
};

export const toFetchHandler = (runtime: FateExecutorRuntime): FateFetchHandler => {
	let compiled: Promise<CompiledFateServer> | undefined;
	const compiledServer = () =>
		(compiled ??= runtime
			.context()
			.then((context) => compile(Context.get(context, FateServer), runtime)));
	return async (request, context) => (await compiledServer()).handleRequest(request, context);
};
