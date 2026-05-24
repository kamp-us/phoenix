/**
 * The fate ↔ Effect bridge.
 *
 * fate's resolvers and source handlers are plain async functions. phoenix's
 * domain lives in Effect `Context.Service`s. This module is the single seam
 * between them: a small helper family — `fateQuery`, `fateList`,
 * `fateMutation`, `fateSource` — wraps an Effect generator into the async
 * function fate expects, running it through the per-request `ManagedRuntime`
 * carried on {@link FateContext}.
 *
 * **No `runtime.runPromise*` appears anywhere outside this file.** Resolvers
 * and executors are generators; the runner here does the
 * `runtime → Exit → wire-error` dance once.
 *
 * See `.patterns/fate-effect-bridge.md` and ADR 0016.
 */
import type {ConnectionResult, SourceRegistry} from "@nkzw/fate/server";
import {FateRequestError} from "@nkzw/fate/server";
import {Cause, Effect, Exit} from "effect";
import type {FateContext} from "./context";
import {encodeFateError} from "./errors";
import type {FateRuntime} from "./runtime";

type Selection = ReadonlyArray<string>;

/**
 * Build a request-runtime Effect from a resolver/executor generator. The
 * generator yields heterogeneous services (`yield* Stats`, `yield* Auth`, …),
 * so its element type is `any` and `Effect.gen` infers the environment as
 * `unknown`; we assert it back to `FateRuntime.Context`, which the request
 * runtime provides. This is the single assertion the bridge makes — see the
 * note on {@link runEffect}.
 */
const genEffect = <A>(
	body: () => Generator<any, A, any>,
): Effect.Effect<A, unknown, FateRuntime.Context> =>
	Effect.gen(body) as Effect.Effect<A, unknown, FateRuntime.Context>;

/**
 * The one place `runPromiseExit` is called. Runs an Effect through the request
 * runtime and resolves the `Exit`:
 *
 *   - `Exit.Success`            → the value.
 *   - tagged failure            → `encodeFateError` → throw (fate serializes it).
 *   - `FateRequestError`        → pass through verbatim (already wire-shaped).
 *   - defect (uncaught throw)   → `Cause.squash` → `encodeFateError` → throw.
 *
 * fate's `executeOperation` catches the throw and turns it into
 * `{ok: false, error: {code, message, issues?}}`.
 */
const runEffect = <A>(
	ctx: FateContext,
	// The generator wrappers below build this via `Effect.gen` over a
	// `Generator<any, A, any>`, so the environment channel erases to `unknown`
	// at this boundary — exactly as the GraphQL `resolver()` wrapper does
	// (`EffectContext<any>`). The resolver/executor bodies are checked at their
	// own definition site, where `yield* Service` carries the real types; the
	// request runtime provides `FateRuntime.Context` at run time. We assert that
	// shape into `runPromiseExit` rather than leaking `any` outward.
	effect: Effect.Effect<A, unknown, FateRuntime.Context>,
): Promise<A> =>
	ctx.runtime.runPromiseExit(effect).then((exit) => {
		if (Exit.isSuccess(exit)) {
			return exit.value;
		}
		const found = Cause.findError(exit.cause);
		if (found._tag === "Success") {
			const e = found.success;
			// Already wire-shaped (resolver-side validation, Auth) → pass through.
			if (e instanceof FateRequestError) {
				throw e;
			}
			throw encodeFateError(e);
		}
		// Defects (uncaught throw that never became an Effect failure).
		throw encodeFateError(Cause.squash(exit.cause));
	});

/** A root-query resolver argument bag fate hands the wrapped function. */
export interface QueryArgs<Args> {
	readonly ctx: FateContext;
	readonly input: {readonly args?: Args};
	readonly select: Array<string>;
}

/** A mutation resolver argument bag fate hands the wrapped function. */
export interface MutationArgs<Input> {
	readonly ctx: FateContext;
	readonly input: Input;
	readonly select: Array<string>;
}

/**
 * Wrap an Effect generator as a fate **root query** resolver:
 * `({ctx, input:{args}, select}) => Promise<Output>`. The generator returns the
 * shaped output directly — query resolvers are not masked through a source.
 *
 * The generator's yield type is `any` for the same reason the GraphQL
 * `resolver()` wrapper uses it: `Effect.gen` requires a `Yieldable` element and
 * resolver bodies `yield*` heterogeneous services. The runner constrains the
 * environment to `FateRuntime.Context`.
 */
export const fateQuery =
	<Args, A>(body: (o: {args: Args | undefined; select: Selection}) => Generator<any, A, any>) =>
	({ctx, input, select}: QueryArgs<Args>): Promise<A> =>
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
	({ctx, input, select}: QueryArgs<Args>): Promise<ConnectionResult<A>> =>
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
	({ctx, input, select}: MutationArgs<Input>): Promise<A> =>
		runEffect(
			ctx,
			genEffect(() => body({input, select})),
		);

/**
 * fate's `SourceExecutor` is the value half of `SourceRegistry<Context>`. fate
 * 1.0.3 does not re-export the `SourceExecutor` type from `@nkzw/fate/server`,
 * so we recover it from the exported `SourceRegistry` Map's value type rather
 * than naming it directly.
 */
type SourceExecutor = SourceRegistry<FateContext> extends Map<unknown, infer V> ? V : never;

/**
 * Wrap a set of Effect-generator source handlers as a fate `SourceExecutor`.
 *
 * Handlers return **raw domain rows**, not shaped output — fate masks each row
 * to the requested view + selection afterward (via the source plan), so
 * handlers never receive `select`; they just fetch. `byIds` is the workhorse
 * (it avoids the N+1 the cache exists to prevent) — implement it for every type
 * reachable as a relation. See `.patterns/fate-sources.md`.
 */

export const fateSource = <Item extends Record<string, unknown>>(handlers: {
	byId?: (id: string) => Generator<any, Item | null, any>;
	byIds?: (ids: ReadonlyArray<string>) => Generator<any, ReadonlyArray<Item>, any>;
	connection?: (page: {
		args?: Record<string, unknown>;
		cursor?: string;
		direction: "forward" | "backward";
		take: number;
		skip?: number;
	}) => Generator<any, ReadonlyArray<Item>, any>;
}): SourceExecutor => {
	const {byId, byIds, connection} = handlers;
	// Build as one literal with conditional spreads: under
	// `exactOptionalPropertyTypes`, assigning to declared-optional fields would
	// widen them to `… | undefined`, which the `SourceExecutor` shape rejects.
	return {
		...(byId
			? {
					byId: ({ctx, id}: {ctx: FateContext; id: string}) =>
						runEffect(
							ctx,
							genEffect(() => byId(id)),
						),
				}
			: {}),
		...(byIds
			? {
					byIds: ({ctx, ids}: {ctx: FateContext; ids: Array<string>}) =>
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
						ctx: FateContext;
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
