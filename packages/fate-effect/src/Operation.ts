/**
 * `Fate.query` / `Fate.list` / `Fate.mutation` — the record-entry
 * constructors.
 *
 * The resolver half of the loader/resolver split (PRD; sources are the loader
 * half, see `Source.ts`): operations carry domain logic, typed errors, and
 * writes. Each constructor pairs a **pure-data definition** with an
 * **`Effect.fn` handler**:
 *
 * - The definition carries the Effect Schema input/args (replacing zod), the
 *   success view (`type:` — a `FateDataView` class or the wire type-name
 *   string), and the declared error union (`error:` — an error class, or
 *   `Schema.Union([...])` of several).
 * - The handler is a user-authored `Effect.fn("<wire name>")` function — the
 *   wire name is the span name, so stack traces point at the operation
 *   (effect-smol `LLMS.md` § "Using Effect.fn"). The handler slot accepts
 *   **Effect-returning functions only**: raw generators do not typecheck.
 *   (This is the deliberate asymmetry with `Fate.source`, which wraps plain
 *   bodies itself: a source capability's span name is fully determined by
 *   entity + capability, while an operation's wire name is author-owned.)
 * - **The error channel is checked against the declared union at the call
 *   site**: the handler's `E` must extend the union's instance type, so
 *   failing with an undeclared error is a compile error, not a runtime
 *   wire-code fallback.
 *
 * Records stay exactly fate's shape — plain objects keyed by dotted wire
 * names:
 *
 * ```ts
 * export const mutations = {
 *   "definition.add": Fate.mutation(
 *     {input: AddDefinitionInput, type: DefinitionView, error: Schema.Union([BodyRequired])},
 *     Effect.fn("definition.add")(function* ({input}) { ... }),
 *   ),
 * };
 * ```
 *
 * Each entry also carries `resolve` — the **decode-then-run wrapper** the
 * compile step (task 7) adapts to fate's promise-shaped resolvers:
 *
 * - Mutation `input` is decoded by the definition's Schema before the handler
 *   runs; a decode failure is an {@link InputValidationError} (annotated
 *   `VALIDATION_ERROR`, the code fate itself emits for schema failures), so
 *   the wire-error codec derives the wire shape with no extra wiring.
 * - Query/list `args` decode the wire args **including absence**: missing
 *   wire args decode as the empty bag `{}`, so args schemas are structs of
 *   optional fields and handlers never see `undefined` args when a schema is
 *   declared. A definition without an `args` schema passes `undefined` —
 *   stray wire args are not smuggled past the declared contract.
 */
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {WireCode} from "./WireError.ts";

/** The wire selection fate hands a resolver (`select`). */
export type OperationSelect = ReadonlyArray<string>;

/**
 * What a definition's `type:` accepts: the wire type-name string, or a
 * `FateDataView` class (anything carrying a literal `typeName`).
 */
export type TypeRef = string | {readonly typeName: string};

/** The wire type name behind a {@link TypeRef}, kept literal. */
export type TypeNameOf<T> = T extends string
	? T
	: T extends {readonly typeName: infer N extends string}
		? N
		: undefined;

/**
 * The normalized `type` of an entry whose definition may omit it. Two-branch
 * on purpose: a present `type` keeps its literal name; a declared-but-
 * optional `type` (the widened `QueryDefinition` shape) widens to
 * `string | undefined`; an absent key (`T` infers `unknown`) maps to
 * `undefined`.
 */
export type DefinitionTypeName<D> = D extends {readonly type: infer T}
	? TypeNameOf<T>
	: D extends {readonly type?: infer T}
		? TypeNameOf<T> | undefined
		: undefined;

/**
 * The Schema-derived input-validation failure: what `resolve` fails with when
 * the definition's Schema rejects the wire input/args. Annotated with the
 * `VALIDATION_ERROR` wire code — the code fate's own schema validation emits —
 * so `encodeWireError` derives the wire error with no registry edit. The
 * message is the Schema issue rendering (validation feedback is user-facing
 * by definition; defects stay behind the internal-error wall).
 */
export class InputValidationError extends Schema.TaggedErrorClass<InputValidationError>()(
	"fate-effect/InputValidationError",
	{message: Schema.String},
	{[WireCode]: "VALIDATION_ERROR"},
) {}

/** A query definition: optional args Schema, error union, and success view. */
export interface QueryDefinition {
	readonly args?: Schema.Top;
	readonly error?: Schema.Top;
	readonly type?: TypeRef;
}

/** A list definition: args Schema (pagination at minimum) + success view. */
export interface ListDefinition {
	readonly args: Schema.Top;
	readonly error?: Schema.Top;
	readonly type: TypeRef;
}

/** A mutation definition: input Schema, success view, declared error union. */
export interface MutationDefinition {
	readonly input: Schema.Top;
	readonly error?: Schema.Top;
	readonly type: TypeRef;
}

/** The decoded args a query/list handler receives (`undefined` if no schema). */
export type DefinitionArgs<D> = D extends {readonly args: infer S extends Schema.Top}
	? S["Type"]
	: undefined;

/** The decoded input a mutation handler receives. */
export type DefinitionInput<D> = D extends {readonly input: infer S extends Schema.Top}
	? S["Type"]
	: never;

/**
 * The WIRE args of a query/list definition — the args Schema's ENCODED side,
 * what the CLIENT sends before the server decodes (`undefined` if no schema).
 * The codegen server's `InferFateAPI` surface (task 8) is typed in these:
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

/** The declared error union's instance type — the handler's `E` bound. */
export type DefinitionErrors<D> = D extends {readonly error: infer S extends Schema.Top}
	? S["Type"]
	: never;

/** What decoding can fail with: nothing unless a Schema is declared. */
export type DefinitionDecodeError<D> = D extends
	| {readonly args: Schema.Top}
	| {readonly input: Schema.Top}
	? InputValidationError
	: never;

/** Services the definition's Schemas require to decode (usually `never`). */
export type DefinitionDecodingServices<D> =
	| (D extends {readonly args: infer S extends Schema.Top} ? S["DecodingServices"] : never)
	| (D extends {readonly input: infer S extends Schema.Top} ? S["DecodingServices"] : never);

/** What a query/list handler receives: decoded args + the wire selection. */
export interface QueryHandlerInput<D> {
	readonly args: DefinitionArgs<D>;
	readonly select: OperationSelect;
}

/** What a mutation handler receives: decoded input + the wire selection. */
export interface MutationHandlerInput<D> {
	readonly input: DefinitionInput<D>;
	readonly select: OperationSelect;
}

/** The raw wire bag `resolve` takes for queries/lists (args may be absent). */
export interface RawArgsInput {
	readonly args?: unknown;
	readonly select: OperationSelect;
}

/** The raw wire bag `resolve` takes for mutations. */
export interface RawMutationInput {
	readonly input: unknown;
	readonly select: OperationSelect;
}

/**
 * What {@link query} returns: the definition (pure data), the normalized wire
 * `type`, the paired handler, and `resolve` — the decode-then-run wrapper the
 * compile step adapts to fate.
 */
export interface FateQuery<D extends QueryDefinition, A, E, R> {
	readonly kind: "query";
	readonly definition: D;
	readonly type: DefinitionTypeName<D>;
	readonly handler: (input: QueryHandlerInput<D>) => Effect.Effect<A, E, R>;
	readonly resolve: (
		input: RawArgsInput,
	) => Effect.Effect<A, E | DefinitionDecodeError<D>, R | DefinitionDecodingServices<D>>;
}

/** As {@link FateQuery}, with the success pinned to fate's `ConnectionResult`. */
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

/** As {@link FateQuery}, for mutations: wire input decoded by the definition. */
export interface FateMutation<D extends MutationDefinition, A, E, R> {
	readonly kind: "mutation";
	readonly definition: D;
	readonly type: DefinitionTypeName<D>;
	readonly handler: (input: MutationHandlerInput<D>) => Effect.Effect<A, E, R>;
	readonly resolve: (
		input: RawMutationInput,
	) => Effect.Effect<A, E | DefinitionDecodeError<D>, R | DefinitionDecodingServices<D>>;
}

/**
 * The services an operation requires — the `R` of its `resolve` (handler
 * services plus any Schema decoding services). `FateServer.layer` (task 5)
 * unions these across the config, like `FateSourceServices` for sources.
 */
export type FateOperationServices<Op> = Op extends {
	readonly resolve: (input: never) => Effect.Effect<infer _A, infer _E, infer R>;
}
	? R
	: never;

/** Normalize a {@link TypeRef} to the wire type-name string. */
function typeNameOf(ref: TypeRef): string;
function typeNameOf(ref: TypeRef | undefined): string | undefined;
function typeNameOf(ref: TypeRef | undefined): string | undefined {
	return typeof ref === "string" ? ref : ref?.typeName;
}

/** Map a Schema decode failure onto the annotated wire-coded error. */
const toValidationError = (error: Schema.SchemaError): InputValidationError =>
	new InputValidationError({message: error.message});

/**
 * Build the decode-then-run wrapper for query/list args. Absent wire args
 * decode as the empty bag (see the module doc); without a schema the handler
 * gets `undefined` — undeclared wire args never reach it.
 */
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

/** Build the decode-then-run wrapper for mutation input. */
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

/**
 * Build a root-query entry from a pure-data definition and an
 * `Effect.fn("<wire name>")` handler. See the module doc for the contract.
 */
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

/**
 * Build a root-list entry: same shape as {@link query}, success pinned to
 * fate's `ConnectionResult` (keyset pagination stays service-owned, ADR 0019).
 */
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
