/**
 * The v1 compile step — a validated `FateServer` service → a pure
 * `createFateServer` call. Exposed
 * publicly as `FateExecutor.compile` / `FateExecutor.toFetchHandler` — the
 * namespace is assembled in the barrel (`index.ts`).
 *
 * **Since the v2 cutover (ADR 0043) this module no longer serves `/fate`.**
 * The deployed route runs `FateInterpreter.handleRequest` (`Interpreter.ts`)
 * on the request fiber; what remains here has exactly ONE consumer:
 *
 *   - **`compile`/`toFetchHandler` are the differential oracle's BASELINE** —
 *     the oracle suites (`Interpreter*.test.ts`) byte-compare the interpreter against fate's own
 *     `createFateServer` over these compiled executors. The oracle is the
 *     regression net for the native plane, so the v1 side stays exactly as
 *     it served, including its `ManagedRuntime` conversion point.
 *
 * The build-time codegen surface (`toCodegenServer`) lives in `Codegen.ts`:
 * that module is the PRODUCTION build path
 * every deploy runs; this one is the frozen test-harness baseline. They
 * share the compiled-definition vocabulary through `Compiled.ts` and never
 * import each other.
 *
 * The compiled fate server IS a real fate server — the client manifest holds
 * by construction — and every compiled resolver is the same four-step
 * pipeline:
 *
 *   1. **Decode** — the entry's `resolve` (built in `Operation.ts`) runs the
 *      definition's Schema before the handler; a decode failure is the
 *      annotated `InputValidationError`.
 *   2. **Provide** — the two genuinely per-request services come off the
 *      request context as VALUES (`CurrentUser` from the session,
 *      `LivePublisher` from the request's execution context), then the
 *      build-time services captured by `FateServer.layer`
 *      (`service.services`) are provided underneath — the ONE shared
 *      provision pipeline (`provideRequestPair`, `Provision.ts`), the same
 *      one the v2 interpreter and walk apply.
 *   3. **Run** — through the ONE worker-level `ManagedRuntime`, the package's
 *      single Effect→Promise conversion point ({@link FateExecutorRuntime};
 *      effect-smol `LLMS.md` § "Integrating Effect into existing
 *      applications" — fate's `(args) => Promise` resolvers are exactly the
 *      non-Effect callback boundary `ManagedRuntime` targets, ADR 0041).
 *      Because each resolver fiber starts from that runtime, its `Effect.fn`
 *      span nests under the runtime's ambient request span instead of
 *      opening a detached root.
 *   4. **Encode failures** — declared annotated errors and the validation
 *      error map through `encodeWireError` (the `FateWireCode` codec);
 *      defects collapse to the fixed internal error, never leaking details;
 *      a `FateRequestError` passes through verbatim.
 *
 * ## The erased→kernel boundary (the package's F7, contained)
 *
 * The compile step works TYPE-ERASED: `FateServer.layer`'s public R already
 * carried composition correctness (a config whose handlers need a domain
 * service cannot become a dischargeable layer without it), so the erased
 * entry shapes stored on the service carry `R = unknown`, and definition
 * objects sit behind deliberately weak portable types (TS2883 — fate's view
 * symbol must not surface in exported config types). Recovering both is a
 * handful of single named-type narrowings, each a one-direction comparable
 * cast (never `as any` / a laundering double-cast), each marked
 * `erased→kernel` where it lives — the request-pipeline `R: unknown → never`
 * re-pin in `Provision.ts` (shared with the interpreter and walk), the
 * definition/source recoveries in `Compiled.ts` (shared with the codegen
 * build) — the same contained-boundary precedent as `WireError.ts`'s
 * protocol-code widening.
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
 * The worker-level `ManagedRuntime` the compiled server runs on: built ONCE
 * per isolate from `FateServer.layer(config)` with the domain layers
 * provided (`ManagedRuntime` is contravariant in R, so a runtime carrying
 * more services than `FateServer` satisfies this). ADR 0041's runtime
 * doctrine: one runtime, never disposed on CF (no shutdown hook).
 */
export type FateExecutorRuntime = ManagedRuntime.ManagedRuntime<FateServer, never>;

/**
 * The oracle baseline's request context: the served contract
 * ({@link FateRequestContext}) plus the one field only THIS path consumes —
 * `signal`, handed to the runtime's promise runner in {@link runResolve} so
 * an abort interrupts the resolver fiber. Executor-local on purpose:
 * the serving path (`FateInterpreter`) leaves interruption to the
 * caller (the worker route wires abort→interruption at the platform edge,
 * ADR 0043), so the served contract must not carry an abort knob — a
 * `runPromise`-shaped conversion point is the only place one exists, and the
 * v1 compile path is the only such point in the package.
 */
export interface ExecutorRequestContext extends FateRequestContext {
	readonly signal?: AbortSignal;
}

/** The compiled fate server — fate's own value, API type-erased. */
export type CompiledFateServer = KernelFateServer<unknown, ExecutorRequestContext>;

/** What {@link toFetchHandler} returns: fate's handleRequest, bound. */
export type FateFetchHandler = (
	request: Request,
	context: ExecutorRequestContext,
) => Promise<Response>;

/** What every compiled resolver closes over: the runtime + captured services. */
interface CompileOptions {
	readonly runtime: FateExecutorRuntime;
	readonly services: Context.Context<never>;
}

// --- the single conversion point ----------------------------------------------------

/**
 * Run one resolver effect: steps 2–4 of the module doc's pipeline —
 * provision (`provideRequestPair`), the worker runtime (the package's ONE
 * Effect→Promise conversion), failure/defect encoding via `encodeWireError`
 * on the `Exit`. fate's `executeOperation` catches the throw and serializes
 * `{ok: false, error: {code, message}}`.
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
			// `failureOf` (WireError.ts, shared with the interpreter): the typed
			// failure if one exists, otherwise the squashed defect.
			throw encodeWireError(failureOf(exit.cause));
		});

// --- compiled operation records ------------------------------------------------------

/**
 * One adapter for both args-shaped categories — queries and lists were
 * byte-identical adapters, so the success channel is generic:
 * `unknown` for a query entry, fate's connection envelope for a list entry.
 */
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

// --- compiled sources ------------------------------------------------------------------

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

/**
 * Compile the config's source entries into fate's source resolver: adapted
 * Effect executors in one identity-keyed registry (see
 * `buildSourceResolver`, `Compiled.ts`). A capability-less entry
 * (`handlers: {}`) adapts to an empty executor — registered for `getSource`,
 * loud on any capability call.
 */
export const compileFateSources = (
	sources: FateSourcesList,
	options: CompileOptions,
): CompiledFateSources =>
	buildSourceResolver(sources, (entry) => adaptSourceHandlers(options, entry.handlers));

// --- the compile step + fetch handler -----------------------------------------------

/**
 * Compile a validated `FateServer` service into a real `createFateServer`
 * value over the worker runtime. Pure construction — no request state; the
 * per-request pair arrives later through each request's adapterContext
 * ({@link ExecutorRequestContext}).
 */
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

/**
 * Build the fetch handler over a runtime: resolves the `FateServer` service
 * from the runtime (first call builds the layer — config validation
 * surfaces here), compiles it ONCE, and exposes fate's `handleRequest`
 * bound to the compiled server. Since the v2 cutover this is the oracle
 * harness's baseline entry point, not a serving surface.
 *
 * ```ts
 * const runtime = ManagedRuntime.make(FateServer.layer(config).pipe(Layer.provide(domainLayers)));
 * const handleFate = FateExecutor.toFetchHandler(runtime);
 * // per request: handleFate(request, {currentUser, livePublisher, signal})
 * ```
 */
export const toFetchHandler = (runtime: FateExecutorRuntime): FateFetchHandler => {
	let compiled: Promise<CompiledFateServer> | undefined;
	const compiledServer = () =>
		(compiled ??= runtime
			.context()
			.then((context) => compile(Context.get(context, FateServer), runtime)));
	return async (request, context) => (await compiledServer()).handleRequest(request, context);
};
