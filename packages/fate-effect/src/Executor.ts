/**
 * `FateExecutor` — the v1 compile step: a validated `FateServer` service →
 * a pure `createFateServer` call (PRD stories 8, 11; tasks.md task 7).
 *
 * The compiled fate server IS a real fate server — the client manifest,
 * `InferFateAPI`, and Vite codegen hold by construction — and every compiled
 * resolver is the same four-step pipeline:
 *
 *   1. **Decode** — the entry's `resolve` (built in `Operation.ts`) runs the
 *      definition's Schema before the handler; a decode failure is the
 *      annotated `InputValidationError`.
 *   2. **Provide** — the two genuinely per-request services come off the
 *      request context as VALUES (`CurrentUser` from the session,
 *      `LivePublisher` from the request's execution context), then the
 *      build-time services captured by `FateServer.layer`
 *      (`service.services`) are provided underneath.
 *   3. **Run** — through the ONE worker-level `ManagedRuntime`, the package's
 *      single Effect→Promise conversion point ({@link FateExecutorRuntime};
 *      effect-smol `LLMS.md` § "Integrating Effect into existing
 *      applications" — fate's `(args) => Promise` resolvers are exactly the
 *      non-Effect callback boundary `ManagedRuntime` targets, ADR 0041).
 *      Because each resolver fiber starts from that runtime, its `Effect.fn`
 *      span nests under the runtime's ambient request span instead of
 *      opening a detached root.
 *   4. **Encode failures** — declared annotated errors and the validation
 *      error map through `encodeWireError` (the `fateWireCode` codec);
 *      defects collapse to the fixed internal error, never leaking details;
 *      a `FateRequestError` passes through verbatim.
 *
 * **Raw legacy records pass through untouched**: a bridge-shaped promise
 * resolver (or `{definition, executor}` source pair) lands in the compiled
 * options verbatim and receives the SAME ctx object the route passes as
 * adapterContext — `FateContext` compatibility during migration is identity,
 * not adaptation (PRD story 12).
 *
 * ## The erased→kernel boundary (the package's F7, contained)
 *
 * The compile step works TYPE-ERASED: `FateServer.layer`'s public R already
 * carried composition correctness (a config whose handlers need a domain
 * service cannot become a dischargeable layer without it), so the erased
 * entry shapes stored on the service carry `R = unknown`, and the runtime
 * values of legacy entries/definitions are fate's own objects behind
 * deliberately weak portable types (TS2883 — fate's view symbol must not
 * surface in exported config types). Recovering both is a handful of single
 * named-type narrowings, each a one-direction comparable cast (never
 * `as any` / a laundering double-cast), each marked `erased→kernel` below —
 * the same contained-boundary precedent as the bridge's `genEffect` (ADR
 * 0041 F7) and `WireError.ts`'s protocol-code widening.
 */
import type {
	ConnectionResult,
	FateServer as KernelFateServer,
	SourceDefinition,
	SourceRegistry,
} from "@nkzw/fate/server";
import {createFateServer} from "@nkzw/fate/server";
import {Cause, Context, Effect, Exit, type ManagedRuntime, Option} from "effect";
import {CurrentUser} from "./CurrentUser.ts";
import {LivePublisher} from "./LivePublisher.ts";
import type {
	AnyFateList,
	AnyFateMutation,
	AnyFateQuery,
	AnyFateSourceHandlers,
	FateListsRecord,
	FateMutationsRecord,
	FateQueriesRecord,
	FateServerService,
	FateSourcesList,
	RawFateOperation,
	SourceDefinitionLike,
} from "./Server.ts";
import {FateServer, FateServerConfigError} from "./Server.ts";
import {encodeWireError} from "./WireError.ts";

type AnyRow = Record<string, unknown>;

// --- the per-request contract -----------------------------------------------------

/**
 * What the worker hands the fetch handler per request: the per-request pair
 * as VALUES — `currentUser` from the validated session, `livePublisher` from
 * the request's execution context (built worker-side, e.g. via
 * `livePublisherFor`; the package never imports the implementation) — plus
 * an optional abort signal so a disconnected client interrupts the resolver
 * fiber.
 *
 * This object IS fate's adapterContext and the ctx every resolver receives:
 * the worker may carry extra fields on it (the legacy `FateContext` members
 * during migration coexistence) — compiled resolvers read only the pair,
 * legacy resolvers read their own fields, both off the same object.
 */
export interface FateRequestContext {
	readonly currentUser: typeof CurrentUser.Service;
	readonly livePublisher: typeof LivePublisher.Service;
	readonly signal?: AbortSignal;
}

/**
 * The worker-level `ManagedRuntime` the compiled server runs on: built ONCE
 * per isolate from `FateServer.layer(config)` with the domain layers
 * provided (`ManagedRuntime` is contravariant in R, so a runtime carrying
 * more services than `FateServer` satisfies this). ADR 0041's runtime
 * doctrine: one runtime, never disposed on CF (no shutdown hook).
 */
export type FateExecutorRuntime = ManagedRuntime.ManagedRuntime<FateServer, never>;

/** The compiled fate server — fate's own value, API type-erased. */
export type CompiledFateServer = KernelFateServer<unknown, FateRequestContext>;

/** What {@link FateExecutor.toFetchHandler} returns: fate's handleRequest, bound. */
export type FateFetchHandler = (request: Request, context: FateRequestContext) => Promise<Response>;

/** What every compiled resolver closes over: the runtime + captured services. */
interface CompileOptions {
	readonly runtime: FateExecutorRuntime;
	readonly services: Context.Context<never>;
}

// --- the single conversion point ----------------------------------------------------

/**
 * erased→kernel: re-pin an erased entry effect's requirements to `never` so
 * the worker runtime can run it. The erased shapes carry `R = unknown` (the
 * covariant top — every entry assigns into the config records); the REAL
 * requirements were enforced where they are enforceable: the handler's own
 * definition site typed them, `FateServer.layer`'s public R surfaced their
 * union minus the per-request pair, and the layer could not have produced a
 * runtime without discharging it. A genuinely missing service still fails
 * loudly at run time ("Service not found"), never silently.
 */
const toRunnable = <A>(
	effect: Effect.Effect<A, unknown, unknown>,
): Effect.Effect<A, unknown, never> => effect as Effect.Effect<A, unknown, never>;

/**
 * Run one resolver effect: provide the per-request pair (the request context
 * VALUES win over anything beneath), provide the captured build-time
 * services, run through the worker runtime — the package's ONE
 * Effect→Promise conversion — and map the `Exit`:
 *
 *   - success → the value;
 *   - failure → `encodeWireError(error)` thrown (annotated errors keep their
 *     wire code, `FateRequestError` passes through);
 *   - defect → `encodeWireError(Cause.squash(...))` thrown (un-annotated
 *     defects become the fixed internal error — no detail leak).
 *
 * fate's `executeOperation` catches the throw and serializes
 * `{ok: false, error: {code, message}}`.
 */
const runResolve = <A>(
	options: CompileOptions,
	ctx: FateRequestContext,
	effect: Effect.Effect<A, unknown, unknown>,
): Promise<A> =>
	options.runtime
		.runPromise(
			Effect.exit(
				toRunnable(
					effect.pipe(
						Effect.provideService(CurrentUser, ctx.currentUser),
						Effect.provideService(LivePublisher, ctx.livePublisher),
						Effect.provideContext(options.services),
					),
				),
			),
			{signal: ctx.signal},
		)
		.then((exit) => {
			if (Exit.isSuccess(exit)) {
				return exit.value;
			}
			return Option.match(Cause.findErrorOption(exit.cause), {
				onSome: (error) => {
					throw encodeWireError(error);
				},
				onNone: () => {
					throw encodeWireError(Cause.squash(exit.cause));
				},
			});
		});

// --- compiled operation records ------------------------------------------------------

/** The resolver argument bag fate hands a compiled operation. */
interface CompiledResolverOptions<Input> {
	readonly ctx: FateRequestContext;
	readonly input: Input;
	readonly select: Array<string>;
}

/** fate's wire args bag for queries/lists (`args` may be absent). */
interface CompiledArgsInput {
	readonly args?: AnyRow | undefined;
}

/** A compiled (or passed-through legacy) fate query definition. */
interface CompiledQueryDefinition {
	readonly type?: string;
	readonly resolve: (options: CompiledResolverOptions<CompiledArgsInput>) => Promise<unknown>;
}

/** As {@link CompiledQueryDefinition}, promising fate's connection envelope. */
interface CompiledListDefinition {
	readonly type?: string;
	readonly defaultSize?: number;
	readonly resolve: (
		options: CompiledResolverOptions<CompiledArgsInput>,
	) => Promise<ConnectionResult<unknown>>;
}

/**
 * A compiled fate mutation definition. fate's `input?: SchemaLike` slot is
 * deliberately NOT populated for compiled entries — the decode already lives
 * in the entry's `resolve` (a second validator would double-validate);
 * legacy entries keep whatever zod schema they carried.
 */
interface CompiledMutationDefinition {
	readonly type: string;
	readonly resolve: (options: CompiledResolverOptions<unknown>) => Promise<unknown>;
}

const adaptQuery = (options: CompileOptions, entry: AnyFateQuery): CompiledQueryDefinition => ({
	...(entry.type !== undefined ? {type: entry.type} : {}),
	resolve: ({ctx, input, select}) =>
		runResolve(options, ctx, entry.resolve({args: input.args, select})),
});

const adaptList = (options: CompileOptions, entry: AnyFateList): CompiledListDefinition => ({
	...(entry.type !== undefined ? {type: entry.type} : {}),
	resolve: ({ctx, input, select}) =>
		runResolve(options, ctx, entry.resolve({args: input.args, select})),
});

const adaptMutation = (
	options: CompileOptions,
	name: string,
	entry: AnyFateMutation,
): CompiledMutationDefinition => {
	const {type} = entry;
	if (type === undefined) {
		// Unreachable for constructor-built entries (`MutationDefinition`
		// requires `type:`); defends the erased shape's wider `string | undefined`.
		throw new FateServerConfigError([`mutation "${name}" carries no wire type`]);
	}
	return {
		type,
		resolve: ({ctx, input, select}) => runResolve(options, ctx, entry.resolve({input, select})),
	};
};

// erased→kernel: a raw legacy entry's runtime value IS the bridge's fate
// resolver record, passed through untouched; only its portable static shape
// (`resolve: (options: never) => unknown`) is too weak to name fate's
// resolver contract. One comparable narrowing per record category.
const legacyQuery = (entry: RawFateOperation): CompiledQueryDefinition =>
	entry as CompiledQueryDefinition;
const legacyList = (entry: RawFateOperation): CompiledListDefinition =>
	entry as CompiledListDefinition;
const legacyMutation = (entry: RawFateOperation): CompiledMutationDefinition =>
	entry as CompiledMutationDefinition;

const compileQueries = (
	options: CompileOptions,
	record: FateQueriesRecord,
): Record<string, CompiledQueryDefinition> => {
	const compiled: Record<string, CompiledQueryDefinition> = {};
	for (const [name, entry] of Object.entries(record)) {
		compiled[name] = entry.kind === undefined ? legacyQuery(entry) : adaptQuery(options, entry);
	}
	return compiled;
};

const compileLists = (
	options: CompileOptions,
	record: FateListsRecord,
): Record<string, CompiledListDefinition> => {
	const compiled: Record<string, CompiledListDefinition> = {};
	for (const [name, entry] of Object.entries(record)) {
		compiled[name] = entry.kind === undefined ? legacyList(entry) : adaptList(options, entry);
	}
	return compiled;
};

const compileMutations = (
	options: CompileOptions,
	record: FateMutationsRecord,
): Record<string, CompiledMutationDefinition> => {
	const compiled: Record<string, CompiledMutationDefinition> = {};
	for (const [name, entry] of Object.entries(record)) {
		compiled[name] =
			entry.kind === undefined ? legacyMutation(entry) : adaptMutation(options, name, entry);
	}
	return compiled;
};

// --- compiled sources ------------------------------------------------------------------

type KernelSourceDefinition = SourceDefinition<AnyRow, unknown>;

/**
 * fate's `SourceExecutor` is the value half of `SourceRegistry<Context>`;
 * `@nkzw/fate/server` does not export the type by name, so it is recovered
 * from the exported Map type (the bridge's own recovery).
 */
type KernelSourceExecutor =
	SourceRegistry<FateRequestContext> extends Map<unknown, infer V> ? V : never;

// erased→kernel: the definition object IS the kernel `SourceDefinition` the
// entry was built with (`Fate.source` creates it once; legacy entries hold
// the feature's exported definition by identity — fate's registry keys on
// that identity). The portable `SourceDefinitionLike` exists only because
// fate's `DataView` would trip TS2883 in exported config types.
const toKernelDefinition = (definition: SourceDefinitionLike): KernelSourceDefinition =>
	definition as KernelSourceDefinition;

// erased→kernel: a legacy executor's runtime value is the bridge's
// promise-shaped `SourceExecutor`, passed through verbatim.
const toKernelExecutor = (executor: object): KernelSourceExecutor =>
	executor as KernelSourceExecutor;

/**
 * Adapt a `Fate.source` entry's spanned Effect handlers to fate's
 * promise-shaped `SourceExecutor`: ids/page in, raw rows out (fate masks to
 * the view afterward). `byIds`/`connection` re-spread `ReadonlyArray` rows
 * into the mutable `Array` fate's contract names; `connection` maps fate's
 * options onto the package's page bag (`args` from `plan.args` — the scoped
 * connection args, e.g. a nested connection's parent key).
 */
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
					byId: ({ctx, id}: {ctx: FateRequestContext; id: string}) =>
						runResolve(options, ctx, byId(id)),
				}
			: {}),
		...(byIds
			? {
					byIds: ({ctx, ids}: {ctx: FateRequestContext; ids: Array<string>}) =>
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
						ctx: FateRequestContext;
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

/**
 * The compiled `sources` option — fate's `{getSource, registry}` resolver
 * surface through portable names (`SourceResolver` is not exported by name;
 * `DataView` is reachable as `SourceDefinition["view"]`).
 */
export interface CompiledFateSources {
	readonly getSource: <Item extends AnyRow>(
		target: SourceDefinition<Item, unknown>["view"] | SourceDefinition<Item, unknown>,
	) => SourceDefinition<Item, unknown>;
	readonly registry: SourceRegistry<FateRequestContext>;
}

/**
 * Compile the config's source entries into fate's source resolver: ONE
 * registry Map keyed by each entry's definition object (the SAME object —
 * fate looks executors up by identity), holding adapted Effect executors and
 * legacy executors side by side; `getSource` resolves a view or definition
 * by `typeName` to the same keyed object.
 */
export const compileFateSources = (
	sources: FateSourcesList,
	options: CompileOptions,
): CompiledFateSources => {
	const registry: SourceRegistry<FateRequestContext> = new Map();
	const byType = new Map<string, KernelSourceDefinition>();
	for (const entry of sources) {
		const definition = toKernelDefinition(entry.definition);
		byType.set(definition.view.typeName, definition);
		registry.set(
			definition,
			entry.handlers === undefined
				? toKernelExecutor(entry.executor)
				: adaptSourceHandlers(options, entry.handlers),
		);
	}
	const getSource = <Item extends AnyRow>(
		target: SourceDefinition<Item, unknown>["view"] | SourceDefinition<Item, unknown>,
	): SourceDefinition<Item, unknown> => {
		// fate calls getSource with a base or list()-wrapped view OR a
		// definition; all carry `typeName`, so resolve by it.
		const typeName = "view" in target ? target.view.typeName : target.typeName;
		const definition = byType.get(typeName);
		if (definition === undefined) {
			throw new Error(`No source registered for '${typeName}'.`);
		}
		// erased→kernel: the Map stores row-erased definitions; fate's generic
		// getSource contract re-pins the caller's `Item` (the bridge's exact
		// narrowing in its hand-built sources resolver).
		return definition as SourceDefinition<Item, unknown>;
	};
	return {getSource, registry};
};

// --- the compile step + fetch handler -----------------------------------------------

/**
 * Compile a validated `FateServer` service into a real `createFateServer`
 * value over the worker runtime. Pure construction — no request state; the
 * per-request pair arrives later through each request's adapterContext
 * ({@link FateRequestContext}).
 */
const compile = (service: FateServerService, runtime: FateExecutorRuntime): CompiledFateServer => {
	const options: CompileOptions = {runtime, services: service.services};
	return createFateServer<
		FateRequestContext,
		Record<never, never>,
		Record<string, CompiledQueryDefinition>,
		Record<string, CompiledListDefinition>,
		Record<string, CompiledMutationDefinition>,
		FateRequestContext
	>({
		// The fetch handler always supplies the per-request context (fate types
		// adapterContext optional); read it through, asserting its presence. The
		// SAME object becomes every resolver's ctx — legacy records keep their
		// FateContext fields by identity.
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
		queries: compileQueries(options, service.queries),
		lists: compileLists(options, service.lists),
		mutations: compileMutations(options, service.mutations),
		sources: compileFateSources(service.sources, options),
		// fate types `live?: false | LiveConfig` — an omitted config key stays
		// omitted (exactOptionalPropertyTypes), it does not become `undefined`.
		...(service.live !== undefined ? {live: service.live} : {}),
	});
};

/**
 * Build the fetch handler over the worker runtime: resolves the `FateServer`
 * service from the runtime (first call builds the layer — init-time config
 * validation surfaces here), compiles it ONCE, and exposes fate's
 * `handleRequest` bound to the compiled server.
 *
 * ```ts
 * const runtime = ManagedRuntime.make(FateServer.layer(config).pipe(Layer.provide(domainLayers)));
 * const handleFate = FateExecutor.toFetchHandler(runtime);
 * // per request: handleFate(request, {currentUser, livePublisher, ...legacyCtx})
 * ```
 */
const toFetchHandler = (runtime: FateExecutorRuntime): FateFetchHandler => {
	let compiled: Promise<CompiledFateServer> | undefined;
	const compiledServer = () =>
		(compiled ??= runtime
			.context()
			.then((context) => compile(Context.get(context, FateServer), runtime)));
	return async (request, context) => (await compiledServer()).handleRequest(request, context);
};

/**
 * The executor surface (PRD's five-export contract): `compile` builds the
 * fate server value from a resolved `FateServer` service; `toFetchHandler`
 * is the worker-facing form. `toCodegenServer` (inert handlers, no database
 * at build time) and the v2 native `route` land in later tasks.
 */
export const FateExecutor = {
	compile,
	toFetchHandler,
};
