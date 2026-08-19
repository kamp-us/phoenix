/**
 * `Fate.source` — the per-entity loader constructor. See ADR 0043.
 *
 * Reads are silent: a missing id is `null`, fewer rows than asked is success.
 * The error channel is pinned `never`, so infrastructure failures are defects.
 *
 * Spans come from the constructor, not the author: each handler body is passed
 * to `Effect.fn("<Entity>.<capability>")` (effect-smol `LLMS.md` § "Using
 * Effect.fn"), so the span name is derived from the view's `typeName` and
 * cannot drift from the entity.
 *
 * The constructor takes the `FateDataView` **class** and reads the kernel view
 * off it — the class itself is never handed to fate (fate's object-walkers
 * skip functions; see `DataView.ts`). The returned `definition` IS a kernel
 * `SourceDefinition`, created once here so fate's identity-keyed source
 * registry has a single stable object from birth.
 */
import type {SourceDefinition} from "@nkzw/fate/server";
import {Effect} from "effect";
import type {DataViewOf} from "./DataView.ts";

/** fate's `AnyRecord` (not exported from the barrel; it is exactly this). */
type AnyRow = Record<string, unknown>;

/** `id` names the row's primary-key FIELD — the field fate refs the entity by. */
export interface SourceOptions {
	readonly id: string;
}

/** The page bag a `connection` handler receives — keyset contract, ADR 0019. */
export interface SourceConnectionInput {
	readonly args?: Record<string, unknown>;
	readonly cursor?: string;
	readonly direction: "backward" | "forward";
	readonly skip?: number;
	readonly take: number;
}

export type SourceHandlerBody<Args extends ReadonlyArray<unknown>, A, R> = (
	...args: Args
) => Generator<Effect.Effect<unknown, never, R>, A, never> | Effect.Effect<A, never, R>;

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
 * At least one of `byId`/`byIds` must be provided — a source with neither
 * cannot load an entity, so it does not typecheck. (`connection` alone is not
 * loading: refs resolve by id.)
 */
export type SourceLoaderContract<Item extends AnyRow> =
	| {readonly byId: SourceHandlerBody<[id: string], Item | null, unknown>}
	| {readonly byIds: SourceHandlerBody<[ids: ReadonlyArray<string>], ReadonlyArray<Item>, unknown>};

/** `R` recovered from either side of the `Effect.fn` body union. */
export type SourceHandlerServices<F> = F extends (...args: never) => infer Ret
	? Ret extends Generator<infer Y, infer _A, infer _N>
		? Y extends Effect.Effect<infer _YA, infer _YE, infer YR>
			? YR
			: never
		: Ret extends Effect.Effect<infer _A, infer _E, infer R>
			? R
			: never
	: never;

export type SourceHandlersServices<H> = {
	[K in keyof H]: SourceHandlerServices<H[K]>;
}[keyof H];

export interface FateSourceHandlers<Item extends AnyRow, R> {
	readonly byId?: (id: string) => Effect.Effect<Item | null, never, R>;
	readonly byIds?: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Item>, never, R>;
	readonly connection?: (
		page: SourceConnectionInput,
	) => Effect.Effect<ReadonlyArray<Item>, never, R>;
}

export interface FateSource<Item extends AnyRow, Name extends string, R> {
	readonly definition: SourceDefinition<Item>;
	readonly typeName: Name;
	readonly handlers: FateSourceHandlers<Item, R>;
}

export type FateSourceServices<S> = S extends FateSource<AnyRow, string, infer R> ? R : never;

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
 * {@link source} deliberately makes a loader-less source unrepresentable; this
 * is the one sanctioned escape hatch. The entry exists so the server's
 * source-completeness validation accepts the view-reachable entity — and for
 * nothing else: the handlers bag is EMPTY, so any actual capability call fails
 * loudly inside the package.
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
