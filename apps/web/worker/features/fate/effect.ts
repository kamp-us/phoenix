/**
 * The fate ↔ Effect bridge.
 *
 * fate's resolvers and source handlers are plain async functions. phoenix's
 * domain lives in Effect `Context.Service`s. This module is the single seam
 * between them: a small helper family — `fateQuery`, `fateList`,
 * `fateMutation`, `fateSource` — wraps an Effect generator into the async
 * function fate expects.
 *
 * The F4 model (ADR 0041, supersedes 0029): there is ONE worker-level
 * `ManagedRuntime`, built once per isolate in worker init (`index.ts`) and
 * carried on every {@link FateContext} as `ctx.runtime`. The bridge runs each
 * resolver THROUGH that runtime, providing only the two genuinely per-request
 * services — `Auth` (the validated session) and `LiveBus` (the publish
 * capability, ADR 0039) — onto each resolver effect with `Effect.provideService`.
 * Nothing is built or disposed per request, and because resolvers run through the
 * runtime their spans nest under the runtime's request span rather than on a
 * detached default-runtime root. This is the LLMS-documented "Integrating Effect
 * into existing applications" pattern (effect-smol `LLMS.md` →
 * `ai-docs/src/03_integration/10_managed-runtime.ts`): fate's `(args) => Promise`
 * resolvers are the non-Effect callback boundary `ManagedRuntime` targets.
 *
 * **No `runPromiseExit` appears anywhere outside this file.** Resolvers and
 * executors are generators; the runner here does the
 * `provide(Auth/LiveBus) → run-on-runtime → Exit → wire-error` dance once.
 *
 * See `.patterns/fate-effect-bridge.md`, `.patterns/alchemy-runtime.md`, and
 * ADR 0016 / 0041.
 */
import type {ConnectionResult, SourceDefinition, SourceRegistry} from "@nkzw/fate/server";
import {FateRequestError} from "@nkzw/fate/server";
import {Cause, Effect, Exit, Option} from "effect";
import {LiveBus} from "../fate-live/event-bus.ts";
import {Auth} from "../pasaport/Auth.ts";
import type {FateContext} from "./context.ts";
import {encodeFateError} from "./errors.ts";
import type {FateEnv, WorkerFateServices} from "./layers.ts";

type Selection = ReadonlyArray<string>;

/**
 * The shape every per-feature `sources.ts` files reaches for: a fully-erased
 * `SourceDefinition` (`Record<string, unknown>` row, `unknown` cursor). The
 * registry keys these objects by identity, so the *static* shape doesn't need
 * to be precise — only the runtime object identity matters.
 */
export type AnySourceDefinition = SourceDefinition<Record<string, unknown>, unknown>;

/**
 * The companion: `AnySourceDefinition["view"]`. Per-feature `sources.ts` files
 * import this to type the `view:` slot of each source literal.
 */
export type AnyDataView = AnySourceDefinition["view"];

/**
 * Build an Effect from a resolver/executor generator. The generator body is
 * typed `Generator<any, A, any>` — its `any` element type makes `Effect.gen`
 * infer the environment as `unknown`, so we assert it back to `R`. This is the
 * bridge's single contained boundary cast (F7).
 *
 * **The cast is irreducible in practice.** `Effect.gen.Return` pins the error
 * channel `E` to `never`, which rejects failing resolvers (a body that does
 * `yield* new BodyRequired(...)` or `yield* Auth.required` — `DrizzleError`,
 * `Unauthorized`). And `R` in the generator yield position is *contravariant*:
 * a narrow-`R` body (`yield* Sozluk`) does not satisfy the wider `R`, and the
 * friction cascades into fate's `QueryDefinition<FateContext<WorkerFateServices>>`
 * server constraint. Kept as one plain `as` (not `as any` / `as unknown as`):
 * resolver bodies are still checked at their own definition sites, and
 * `runEffect` runs them on a runtime that surfaces a wrong environment as a
 * runtime "service not found", not a silent miss. See ADR 0041 (F7).
 */
const genEffect = <A, R>(body: () => Generator<any, A, any>): Effect.Effect<A, unknown, R> =>
	Effect.gen(body) as Effect.Effect<A, unknown, R>;

/**
 * The one place an effect is run. Provides the two per-request service VALUES
 * carried by the {@link FateContext} — `Auth` (the validated session) and
 * `LiveBus` (the publish capability) — onto the resolver Effect, then runs it on
 * the worker-level `ManagedRuntime` ({@link FateContext.runtime}), which supplies
 * the worker singletons (built once per isolate, never disposed per request).
 * Because the resolver runs THROUGH the runtime, its spans nest under the
 * runtime's request span (the F4 observability win) rather than on a detached
 * default-runtime root. The `Exit` resolves identically to before:
 *
 *   - `Exit.Success`            → the value.
 *   - tagged failure            → `encodeFateError` → throw (fate serializes it).
 *   - `FateRequestError`        → pass through verbatim (already wire-shaped).
 *   - defect (uncaught throw)   → `Cause.squash` → `encodeFateError` → throw.
 *
 * Generic in the runtime environment `R` (defaulting to the production worker
 * services) so a test can run a resolver on a tiny marker runtime; production
 * passes the default with zero churn. The effect's environment is `R | Auth |
 * LiveBus`; providing `Auth`/`LiveBus` here discharges those two, leaving exactly
 * `R` — the runtime's own environment.
 *
 * fate's `executeOperation` catches the throw and turns it into
 * `{ok: false, error: {code, message, issues?}}`.
 */
const runEffect = <A, R>(
	ctx: FateContext<R>,
	effect: Effect.Effect<A, unknown, R | Auth | LiveBus>,
): Promise<A> =>
	ctx.runtime
		.runPromiseExit(
			effect.pipe(
				Effect.provideService(Auth, ctx.auth),
				Effect.provideService(LiveBus, ctx.liveBus),
			),
			// Wire the request's abort signal so a disconnected fate client interrupts
			// the resolver fiber (matches `HttpEffect`'s run-with-signal contract).
			{signal: ctx.request.signal},
		)
		.then((exit) => {
			if (Exit.isSuccess(exit)) {
				return exit.value;
			}
			// Unwind the Cause with `findErrorOption` (an `Option`) so no `Result`
			// tag leaks into boundary code.
			return Option.match(Cause.findErrorOption(exit.cause), {
				// Already wire-shaped (resolver-side validation, Auth) → pass through.
				onSome: (e) => {
					throw e instanceof FateRequestError ? e : encodeFateError(e);
				},
				// Defects (uncaught throw that never became an Effect failure).
				onNone: () => {
					throw encodeFateError(Cause.squash(exit.cause));
				},
			});
		});

/** A root-query resolver argument bag fate hands the wrapped function. */
export interface QueryArgs<Args, R = FateEnv> {
	readonly ctx: FateContext<R>;
	readonly input: {readonly args?: Args};
	readonly select: Array<string>;
}

/** A mutation resolver argument bag fate hands the wrapped function. */
export interface MutationArgs<Input, R = FateEnv> {
	readonly ctx: FateContext<R>;
	readonly input: Input;
	readonly select: Array<string>;
}

/**
 * Wrap an Effect generator as a fate **root query** resolver:
 * `({ctx, input:{args}, select}) => Promise<Output>`. The generator returns the
 * shaped output directly — query resolvers are not masked through a source.
 *
 * The generator's yield type is `any`: `Effect.gen` requires a `Yieldable`
 * element and resolver bodies `yield*` heterogeneous services. The runner
 * constrains the environment to {@link FateEnv}.
 */
export const fateQuery =
	<Args, A>(body: (o: {args: Args | undefined; select: Selection}) => Generator<any, A, any>) =>
	<R>({ctx, input, select}: QueryArgs<Args, R>): Promise<A> =>
		runEffect(
			ctx,
			genEffect(() => body({args: input.args, select})),
		);

/**
 * Wrap an Effect generator as a fate **root list** resolver. Same shape as
 * {@link fateQuery} but the generator returns a `ConnectionResult` (see
 * `.patterns/fate-connections.md`).
 */
export const fateList =
	<Args, A>(
		body: (o: {
			args: Args | undefined;
			select: Selection;
		}) => Generator<any, ConnectionResult<A>, any>,
	) =>
	<R>({ctx, input, select}: QueryArgs<Args, R>): Promise<ConnectionResult<A>> =>
		runEffect(
			ctx,
			genEffect(() => body({args: input.args, select})),
		);

/**
 * Wrap an Effect generator as a fate **mutation** resolver:
 * `({ctx, input, select}) => Promise<Output>`. `input` is fate's
 * already-parsed mutation input (thin coercion only — validation stays in the
 * service, ADR 0013).
 */
export const fateMutation =
	<Input, A>(body: (o: {input: Input; select: Selection}) => Generator<any, A, any>) =>
	<R>({ctx, input, select}: MutationArgs<Input, R>): Promise<A> =>
		runEffect(
			ctx,
			genEffect(() => body({input, select})),
		);

/**
 * fate's `SourceExecutor` is the value half of `SourceRegistry<Context>`.
 * `@nkzw/fate/server` does not re-export the `SourceExecutor` type, so we
 * recover it from the exported `SourceRegistry` Map's value type rather than
 * naming it directly.
 *
 * Generic in the runtime env `R` (defaulting to the production worker services)
 * so the per-feature `sources.ts` registries slot into `createFateServer`'s
 * `FateContext` Context unchanged, while the isolation tests can name a marker
 * `R` and drive an executor with a marker-runtime ctx — both cast-free.
 */
export type SourceExecutor<R = WorkerFateServices> =
	SourceRegistry<FateContext<R>> extends Map<unknown, infer V> ? V : never;

/**
 * Wrap a set of Effect-generator source handlers as a fate `SourceExecutor`.
 *
 * Handlers return **raw domain rows**, not shaped output — fate masks each row
 * to the requested view + selection afterward (via the source plan), so
 * handlers never receive `select`; they just fetch. `byIds` is the workhorse
 * (it avoids the N+1 the cache exists to prevent) — implement it for every type
 * reachable as a relation. See `.patterns/fate-sources.md`.
 */

export const fateSource = <Item extends Record<string, unknown>, R = WorkerFateServices>(handlers: {
	byId?: (id: string) => Generator<any, Item | null, any>;
	byIds?: (ids: ReadonlyArray<string>) => Generator<any, ReadonlyArray<Item>, any>;
	connection?: (page: {
		args?: Record<string, unknown>;
		cursor?: string;
		direction: "forward" | "backward";
		take: number;
		skip?: number;
	}) => Generator<any, ReadonlyArray<Item>, any>;
}): SourceExecutor<R> => {
	const {byId, byIds, connection} = handlers;
	// Build as one literal with conditional spreads: under
	// `exactOptionalPropertyTypes`, assigning to declared-optional fields would
	// widen them to `… | undefined`, which the `SourceExecutor` shape rejects.
	return {
		...(byId
			? {
					byId: ({ctx, id}: {ctx: FateContext<R>; id: string}) =>
						runEffect(
							ctx,
							genEffect(() => byId(id)),
						),
				}
			: {}),
		...(byIds
			? {
					byIds: ({ctx, ids}: {ctx: FateContext<R>; ids: Array<string>}) =>
						runEffect(
							ctx,
							genEffect(() => byIds(ids)),
						).then((r) => [...r]),
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
						ctx: FateContext<R>;
						cursor?: string;
						direction: "forward" | "backward";
						take: number;
						skip?: number;
						// fate's `SourcePlan` carries the (scoped) connection args; we
						// forward `plan.args` so a connection executor can read the
						// parent key (e.g. `args.termSlug`). The bridge only touches
						// `plan.args`, so the plan is typed thinly here.
						plan?: {args?: Record<string, unknown>};
					}) =>
						runEffect(
							ctx,
							genEffect(() =>
								connection({
									direction,
									take,
									...(plan?.args !== undefined ? {args: plan.args} : {}),
									...(cursor !== undefined ? {cursor} : {}),
									...(skip !== undefined ? {skip} : {}),
								}),
							),
						).then((r) => [...r]),
				}
			: {}),
	};
};
