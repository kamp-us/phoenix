/**
 * `Fate.query` / `Fate.list` / `Fate.mutation` — the record-entry constructors,
 * the resolver half of the loader/resolver split (`Source.ts` is the loader half).
 * See .patterns/fate-effect-operations.md.
 */
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {FateWireCode} from "./WireError.ts";

export type OperationSelect = ReadonlyArray<string>;

export type TypeRef = string | {readonly typeName: string};

export type TypeNameOf<T> = T extends string
	? T
	: T extends {readonly typeName: infer N extends string}
		? N
		: undefined;

export type DefinitionTypeName<D> = D extends {readonly type: infer T}
	? TypeNameOf<T>
	: D extends {readonly type?: infer T}
		? TypeNameOf<T> | undefined
		: undefined;

/** Annotated with the wire code fate's own schema validation emits, so `encodeWireError` needs no registry edit. */
export class InputValidationError extends Schema.TaggedErrorClass<InputValidationError>()(
	"fate-effect/InputValidationError",
	{message: Schema.String},
	{[FateWireCode]: "VALIDATION_ERROR"},
) {}

export interface QueryDefinition {
	readonly args?: Schema.Top;
	readonly error?: Schema.Top;
	readonly type?: TypeRef;
}

export interface ListDefinition {
	readonly args: Schema.Top;
	readonly error?: Schema.Top;
	readonly type: TypeRef;
}

export interface MutationDefinition {
	readonly input: Schema.Top;
	readonly error?: Schema.Top;
	readonly type: TypeRef;
}

export type DefinitionArgs<D> = D extends {readonly args: infer S extends Schema.Top}
	? S["Type"]
	: undefined;

export type DefinitionInput<D> = D extends {readonly input: infer S extends Schema.Top}
	? S["Type"]
	: never;

/**
 * The WIRE args of a query/list definition — the args Schema's ENCODED side,
 * what the CLIENT sends before the server decodes (`undefined` if no schema).
 * The codegen server's `InferFateAPI` surface is typed in these:
 * a `FiniteFromString` arg is `number` to the handler but `string` on the
 * wire, and the generated client must demand the wire shape.
 */
export type DefinitionWireArgs<D> = D extends {readonly args: infer S extends Schema.Top}
	? S["Encoded"]
	: undefined;

/** The WIRE input of a mutation definition (see {@link DefinitionWireArgs}). */
export type DefinitionWireInput<D> = D extends {readonly input: infer S extends Schema.Top}
	? S["Encoded"]
	: never;

export type DefinitionErrors<D> = D extends {readonly error: infer S extends Schema.Top}
	? S["Type"]
	: never;

export type DefinitionDecodeError<D> = D extends
	| {readonly args: Schema.Top}
	| {readonly input: Schema.Top}
	? InputValidationError
	: never;

export type DefinitionDecodingServices<D> =
	| (D extends {readonly args: infer S extends Schema.Top} ? S["DecodingServices"] : never)
	| (D extends {readonly input: infer S extends Schema.Top} ? S["DecodingServices"] : never);

export interface QueryHandlerInput<D> {
	readonly args: DefinitionArgs<D>;
	readonly select: OperationSelect;
}

export interface MutationHandlerInput<D> {
	readonly input: DefinitionInput<D>;
	readonly select: OperationSelect;
}

export interface RawArgsInput {
	readonly args?: unknown;
	readonly select: OperationSelect;
}

export interface RawMutationInput {
	readonly input: unknown;
	readonly select: OperationSelect;
}

export interface FateQuery<D extends QueryDefinition, A, E, R> {
	readonly kind: "query";
	readonly definition: D;
	readonly type: DefinitionTypeName<D>;
	readonly handler: (input: QueryHandlerInput<D>) => Effect.Effect<A, E, R>;
	readonly resolve: (
		input: RawArgsInput,
	) => Effect.Effect<A, E | DefinitionDecodeError<D>, R | DefinitionDecodingServices<D>>;
}

export interface FateList<D extends ListDefinition, Item, E, R> {
	readonly kind: "list";
	readonly definition: D;
	readonly type: DefinitionTypeName<D>;
	readonly handler: (input: QueryHandlerInput<D>) => Effect.Effect<ConnectionResult<Item>, E, R>;
	readonly resolve: (
		input: RawArgsInput,
	) => Effect.Effect<
		ConnectionResult<Item>,
		E | DefinitionDecodeError<D>,
		R | DefinitionDecodingServices<D>
	>;
}

export interface FateMutation<D extends MutationDefinition, A, E, R> {
	readonly kind: "mutation";
	readonly definition: D;
	readonly type: DefinitionTypeName<D>;
	readonly handler: (input: MutationHandlerInput<D>) => Effect.Effect<A, E, R>;
	readonly resolve: (
		input: RawMutationInput,
	) => Effect.Effect<A, E | DefinitionDecodeError<D>, R | DefinitionDecodingServices<D>>;
}

export type FateOperationServices<Op> = Op extends {
	readonly resolve: (input: never) => Effect.Effect<infer _A, infer _E, infer R>;
}
	? R
	: never;

function typeNameOf(ref: TypeRef): string;
function typeNameOf(ref: TypeRef | undefined): string | undefined;
function typeNameOf(ref: TypeRef | undefined): string | undefined {
	return typeof ref === "string" ? ref : ref?.typeName;
}

const toValidationError = (error: Schema.SchemaError): InputValidationError =>
	new InputValidationError({message: error.message});

/** Without a schema the handler gets `undefined` — undeclared wire args never reach it. */
function makeArgsResolve<A>(
	args: Schema.Top | undefined,
	handler: (input: {
		readonly args: unknown;
		readonly select: OperationSelect;
	}) => Effect.Effect<A, unknown, unknown>,
): (input: RawArgsInput) => Effect.Effect<A, unknown, unknown> {
	if (args === undefined) {
		return (input) => handler({args: undefined, select: input.select});
	}
	const decode = Schema.decodeUnknownEffect(args);
	return (input) =>
		decode(input.args ?? {}).pipe(
			Effect.mapError(toValidationError),
			Effect.flatMap((decoded) => handler({args: decoded, select: input.select})),
		);
}

function makeInputResolve<A>(
	input: Schema.Top,
	handler: (o: {
		readonly input: unknown;
		readonly select: OperationSelect;
	}) => Effect.Effect<A, unknown, unknown>,
): (o: RawMutationInput) => Effect.Effect<A, unknown, unknown> {
	const decode = Schema.decodeUnknownEffect(input);
	return (o) =>
		decode(o.input).pipe(
			Effect.mapError(toValidationError),
			Effect.flatMap((decoded) => handler({input: decoded, select: o.select})),
		);
}

export function query<const D extends QueryDefinition, A, E extends DefinitionErrors<D>, R>(
	definition: D,
	handler: (input: QueryHandlerInput<D>) => Effect.Effect<A, E, R>,
): FateQuery<D, A, E, R>;
export function query<A>(
	definition: QueryDefinition,
	handler: (input: {
		readonly args: unknown;
		readonly select: OperationSelect;
	}) => Effect.Effect<A, unknown, unknown>,
): FateQuery<QueryDefinition, A, unknown, unknown> {
	return {
		kind: "query",
		definition,
		type: typeNameOf(definition.type),
		handler,
		resolve: makeArgsResolve(definition.args, handler),
	};
}

/** Keyset pagination stays service-owned — see ADR 0019. */
export function list<const D extends ListDefinition, Item, E extends DefinitionErrors<D>, R>(
	definition: D,
	handler: (input: QueryHandlerInput<D>) => Effect.Effect<ConnectionResult<Item>, E, R>,
): FateList<D, Item, E, R>;
export function list<Item>(
	definition: ListDefinition,
	handler: (input: {
		readonly args: unknown;
		readonly select: OperationSelect;
	}) => Effect.Effect<ConnectionResult<Item>, unknown, unknown>,
): FateList<ListDefinition, Item, unknown, unknown> {
	return {
		kind: "list",
		definition,
		type: typeNameOf(definition.type),
		handler,
		resolve: makeArgsResolve(definition.args, handler),
	};
}

/**
 * Build a mutation entry: the definition's Schema validates the wire input
 * before the handler runs, and the handler's error channel is checked against
 * the declared union at this call site.
 *
 * The operation contract is deliberately asymmetric — `E` is bound to the
 * declared union, `A` (success) is not bound to the declared `type:` view — and
 * that asymmetry is intrinsic, not an omission (investigated #1366):
 *
 *  - `E extends DefinitionErrors<D>` works because `error:` is a `Schema.Top`,
 *    whose decoded instance type is recoverable as `S["Type"]` (effect-smol
 *    `Schema.ts` `Top`, the `readonly "Type"` member) — an identity projection
 *    ({@link DefinitionErrors}). `type:` is a {@link TypeRef} (a wire type-NAME
 *    ref, or a bare string), carrying no decoded-instance surface to project `A`
 *    against; there is no `S["Type"]` analogue for the success view.
 *  - Even were `type:` narrowed to the `FateDataView` class, the worker success
 *    type is not a function of that class alone: `WorkerEntity<View, DateKeys,
 *    Override>` (`DataView.ts`) needs two per-view arguments — the timestamp
 *    `string`→`Date` correction and the optional/relation override — that encode
 *    worker-vs-wire knowledge living only in the shaper's `=> WorkerEntity<…>`
 *    return annotation, not in the definition. `const D` does recover the View
 *    class through the widened `TypeRef`, but the missing piece is that delta,
 *    not the type-ref narrowing, so binding `A` would re-state the convention at
 *    the definition, not remove it.
 *  - The success channel is intentionally heterogeneous: a full entity, an
 *    id-only eviction ref `{__typename, id}` the client drops, or `null` (no
 *    result). Even the weaker `A extends {__typename: DefinitionTypeName<D>}` is
 *    false against correct handlers (`null` has no `__typename`; an inline
 *    eviction ref's literal is often widened to `string`).
 *
 * So `__typename`/shape alignment between a handler's result and its declared
 * view rests on the **shaper convention** — route the result through a shaper
 * annotated `=> WorkerEntity<typeof SomeView>` (e.g. pano `shapers.ts`); that
 * annotation, where the `DateKeys`/`Override` delta lives, is the enforcement
 * seam, and skipping it (a hand-built inline result) has no compile guard.
 */
export function mutation<const D extends MutationDefinition, A, E extends DefinitionErrors<D>, R>(
	definition: D,
	handler: (input: MutationHandlerInput<D>) => Effect.Effect<A, E, R>,
): FateMutation<D, A, E, R>;
export function mutation<A>(
	definition: MutationDefinition,
	handler: (input: {
		readonly input: unknown;
		readonly select: OperationSelect;
	}) => Effect.Effect<A, unknown, unknown>,
): FateMutation<MutationDefinition, A, unknown, unknown> {
	return {
		kind: "mutation",
		definition,
		type: typeNameOf(definition.type),
		handler,
		resolve: makeInputResolve(definition.input, handler),
	};
}
