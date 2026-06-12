/**
 * `Fate.source` — the per-entity loader constructor.
 *
 * The loader half of the loader/resolver split:
 * sources LOAD, operations RESOLVE. A source's handlers therefore have a
 * deliberately narrow contract:
 *
 * - **At least one of `byId`/`byIds` at the type level** — a source that can't
 *   load is unrepresentable ({@link SourceLoaderContract}).
 * - **Reads are silent**: `byId` returns `null` for a missing id, `byIds`
 *   returns the rows that exist (fewer than asked is success, not failure).
 *   The error channel is pinned `never` — a handler with a typed failure is a
 *   compile error; infrastructure failures are defects (`Effect.die`), exactly
 *   like every other unrecoverable fault.
 * - **`R` is inferred** from the handler bodies and surfaces on the returned
 *   {@link FateSource}, so a source's domain-service requirements participate
 *   in layer composition like any other Effect requirement
 *   ({@link FateSourceServices}, consumed by `FateServer.layer`).
 *
 * Spans come from the constructor, not the author: each provided handler body
 * is passed to `Effect.fn("<Entity>.<capability>")` (effect-smol `LLMS.md` §
 * "Using Effect.fn" — the documented way to get named spans + stack frames on
 * Effect functions). The handler slot accepts exactly what `Effect.fn`'s body
 * parameter accepts — a generator function or an Effect-returning function
 * (`Effect.fn`'s `fn.Traced` body union) — and the span name is derived from
 * the view class's `typeName`, so it cannot drift from the entity.
 *
 * Authoring shape:
 *
 * ```ts
 * export const termSource = Fate.source(TermView, {id: "slug"}, {
 *   byIds: function* (slugs) {
 *     const sozluk = yield* Sozluk;
 *     return yield* sozluk.getTermSummariesByIds(slugs);
 *   },
 * });
 * ```
 *
 * The constructor takes the `FateDataView` **class** and reads the kernel view
 * off it — the class itself is never handed to fate (fate's object-walkers
 * skip functions; see `DataView.ts`). The returned `definition` IS a kernel
 * `SourceDefinition` (`{id, view}`), created once here so fate's
 * identity-keyed source registry has a single stable object from birth.
 */
import type {SourceDefinition} from "@nkzw/fate/server";
import {Effect} from "effect";
import type {DataViewOf} from "./DataView.ts";

/** fate's `AnyRecord` (not exported from the barrel; it is exactly this). */
type AnyRow = Record<string, unknown>;

/**
 * Options for {@link source}: `id` names the row's primary-key field — the
 * field fate refs the entity by (`"slug"` for Term, `"id"` for most).
 */
export interface SourceOptions {
	readonly id: string;
}

/**
 * The page bag a `connection` handler receives. Mirrors the keyset contract
 * (ADR 0019): `cursor` is opaque to the package, `args` carries the
 * connection's scoped args (e.g. the parent key of a nested connection).
 */
export interface SourceConnectionInput {
	readonly args?: Record<string, unknown>;
	readonly cursor?: string;
	readonly direction: "backward" | "forward";
	readonly skip?: number;
	readonly take: number;
}

/**
 * A source handler body: exactly what `Effect.fn(name)` accepts — a generator
 * function or an Effect-returning function — with the error channel pinned
 * `never` (loaders are silent; infra failures are defects).
 */
export type SourceHandlerBody<Args extends ReadonlyArray<unknown>, A, R> = (
	...args: Args
) => Generator<Effect.Effect<unknown, never, R>, A, never> | Effect.Effect<A, never, R>;

/**
 * The full (capability-optional) handlers bag — the inference constraint of
 * {@link source}'s third parameter. Requiredness of the loading capabilities
 * is layered on by {@link SourceLoaderContract}.
 */
export interface SourceHandlersInput<Item extends AnyRow> {
	readonly byId?: SourceHandlerBody<[id: string], Item | null, unknown>;
	readonly byIds?: SourceHandlerBody<[ids: ReadonlyArray<string>], ReadonlyArray<Item>, unknown>;
	readonly connection?: SourceHandlerBody<
		[page: SourceConnectionInput],
		ReadonlyArray<Item>,
		unknown
	>;
}

/**
 * The type-level loader contract: at least one of `byId`/`byIds` must be
 * provided — a source with neither cannot load an entity, so it does not
 * typecheck. (`connection` alone is not loading: refs resolve by id.)
 */
export type SourceLoaderContract<Item extends AnyRow> =
	| {readonly byId: SourceHandlerBody<[id: string], Item | null, unknown>}
	| {readonly byIds: SourceHandlerBody<[ids: ReadonlyArray<string>], ReadonlyArray<Item>, unknown>};

/**
 * The services a single handler body requires: `R` recovered from either side
 * of the `Effect.fn` body union (the yielded effects of a generator body, or
 * the returned effect directly).
 */
export type SourceHandlerServices<F> = F extends (...args: never) => infer Ret
	? Ret extends Generator<infer Y, infer _A, infer _N>
		? Y extends Effect.Effect<infer _YA, infer _YE, infer YR>
			? YR
			: never
		: Ret extends Effect.Effect<infer _A, infer _E, infer R>
			? R
			: never
	: never;

/** The union of {@link SourceHandlerServices} across every provided handler. */
export type SourceHandlersServices<H> = {
	[K in keyof H]: SourceHandlerServices<H[K]>;
}[keyof H];

/**
 * The wrapped handlers a {@link FateSource} carries: plain Effect-returning
 * functions, each already spanned `<Entity>.<capability>` via `Effect.fn`.
 * The compile step adapts these to fate's promise-shaped `SourceExecutor`
 * through the worker runtime.
 */
export interface FateSourceHandlers<Item extends AnyRow, R> {
	readonly byId?: (id: string) => Effect.Effect<Item | null, never, R>;
	readonly byIds?: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Item>, never, R>;
	readonly connection?: (
		page: SourceConnectionInput,
	) => Effect.Effect<ReadonlyArray<Item>, never, R>;
}

/**
 * What {@link source} returns: the kernel `SourceDefinition` (handed to fate
 * unchanged — the registry keys it by identity), the literal entity name (for
 * init-time source-completeness checks and span derivation), and the spanned
 * Effect handlers. `R` is the union of the handlers' requirements.
 */
export interface FateSource<Item extends AnyRow, Name extends string, R> {
	readonly definition: SourceDefinition<Item>;
	readonly typeName: Name;
	readonly handlers: FateSourceHandlers<Item, R>;
}

/**
 * The services a source requires — the `R` of {@link FateSource}, named the
 * way effect v4 names the extractor (`Effect.Services`). `FateServer.layer`
 * unions these across the config to type its own requirements.
 */
export type FateSourceServices<S> = S extends FateSource<AnyRow, string, infer R> ? R : never;

/**
 * Build a per-entity loader from a `FateDataView` class, the primary-key
 * field name, and the load handlers. See the module doc for the contract.
 */
export function source<
	Item extends AnyRow,
	Name extends string,
	H extends SourceHandlersInput<Item> & SourceLoaderContract<Item>,
>(
	View: {readonly view: DataViewOf<Item>; readonly typeName: Name},
	options: SourceOptions,
	handlers: H,
): FateSource<Item, Name, SourceHandlersServices<H>>;
export function source(
	View: {readonly view: DataViewOf<AnyRow>; readonly typeName: string},
	options: SourceOptions,
	handlers: SourceHandlersInput<AnyRow>,
): FateSource<AnyRow, string, unknown> {
	const {typeName} = View;
	const {byId, byIds, connection} = handlers;
	return {
		definition: {id: options.id, view: View.view},
		typeName,
		// Build as one literal with conditional spreads: under
		// `exactOptionalPropertyTypes`, assigning to declared-optional fields
		// would widen them to `… | undefined`.
		handlers: {
			...(byId ? {byId: Effect.fn(`${typeName}.byId`)(byId)} : {}),
			...(byIds ? {byIds: Effect.fn(`${typeName}.byIds`)(byIds)} : {}),
			...(connection ? {connection: Effect.fn(`${typeName}.connection`)(connection)} : {}),
		},
	};
}

/**
 * Register a **synthetic** entity — one whose rows exist only as a resolver's
 * reshape, with no by-id fetch path at all (pasaport's `Contribution`:
 * flattened from definitions/posts/comments by a custom resolver, delivered
 * inline through a parent connection).
 *
 * {@link source} deliberately makes a loader-less source unrepresentable
 * ({@link SourceLoaderContract}); this is the one sanctioned escape hatch.
 * The entry exists so the server's source-completeness validation accepts the
 * view-reachable entity — and for nothing else: the handlers bag is EMPTY, so
 * any actual capability call fails loudly inside the package. On the serving
 * path the walk's capability-less arm fails the load with fate's internal arm
 * (`Walk.ts` `runGroup`); on the oracle baseline the empty bag adapts to an
 * empty executor that fate itself rejects and masks (`Executor.ts`
 * `adaptSourceHandlers`). Identical bytes to the hand-built erased entry this
 * constructor replaces.
 *
 * Reserve this for genuinely synthetic entities; if a fetch path exists,
 * implement `byIds`. A root-only synthetic entity (no view nesting reaches
 * it) needs no source at all — give its operation the wire type-name string.
 */
export function syntheticSource<Item extends AnyRow, Name extends string>(View: {
	readonly view: DataViewOf<Item>;
	readonly typeName: Name;
}): FateSource<Item, Name, never> {
	return {
		// `id` is the conventional PK field name; with zero capabilities it is
		// never used to mask rows — it only completes the kernel definition.
		definition: {id: "id", view: View.view},
		typeName: View.typeName,
		handlers: {},
	};
}
