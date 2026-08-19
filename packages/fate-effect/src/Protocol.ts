/**
 * The v2 wire-protocol codecs — fate's protocol as Effect Schema. See
 * .patterns/fate-effect-interpreter.md § "The protocol codecs".
 *
 * Struct field order IS the serialization order: Schema encode emits keys in
 * declaration order, and that is what keeps the interpreter's output
 * byte-equal to the v1 compiled server's. Do not reorder fields.
 */
import {FateRequestError} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";

export const PROTOCOL_OPERATION_KINDS = ["byId", "list", "mutation", "query"] as const;

/**
 * The canonical wire shape, not the per-kind validation gate (that is
 * {@link decodeProtocolRequest}, which is deliberately more lenient).
 */
export const ProtocolOperation = Schema.Struct({
	args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	id: Schema.String,
	ids: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
	input: Schema.optionalKey(Schema.Unknown),
	kind: Schema.Literals(PROTOCOL_OPERATION_KINDS),
	name: Schema.optionalKey(Schema.String),
	select: Schema.Array(Schema.String),
	type: Schema.optionalKey(Schema.String),
});

export const ProtocolRequest = Schema.Struct({
	operations: Schema.Array(ProtocolOperation),
	version: Schema.Literal(1),
});

/**
 * `code` is deliberately wider than fate's closed union — phoenix's annotated
 * wire codes ride the same field (`WireError.ts`). `path` is never emitted;
 * it exists for the drift pin, which is why it is ordered last.
 */
export const ProtocolError = Schema.Struct({
	code: Schema.String,
	issues: Schema.optionalKey(Schema.Unknown),
	message: Schema.String,
	path: Schema.optionalKey(Schema.String),
});

export const ProtocolSuccessResult = Schema.Struct({
	data: Schema.Unknown,
	id: Schema.String,
	ok: Schema.Literal(true),
});

export const ProtocolFailureResult = Schema.Struct({
	error: ProtocolError,
	id: Schema.String,
	ok: Schema.Literal(false),
});

export const ProtocolOperationResult = Schema.Union([ProtocolSuccessResult, ProtocolFailureResult]);

export const ProtocolResponse = Schema.Struct({
	results: Schema.Array(ProtocolOperationResult),
	version: Schema.Literal(1),
});

export interface ProtocolByIdOperation {
	readonly kind: "byId";
	readonly id: string;
	readonly select: ReadonlyArray<string>;
	readonly args?: {readonly [key: string]: unknown};
	readonly type: string;
	readonly ids: ReadonlyArray<string | number>;
}

/**
 * `name` is guaranteed a string but possibly `""` — fate (and so the
 * interpreter) rejects the empty name at dispatch time with a per-operation
 * `BAD_REQUEST`, not at the protocol gate.
 */
export interface ProtocolNamedOperation {
	readonly kind: "list" | "mutation" | "query";
	readonly id: string;
	readonly select: ReadonlyArray<string>;
	readonly args?: {readonly [key: string]: unknown};
	readonly name: string;
	readonly input?: unknown;
}

export type DecodedProtocolOperation = ProtocolByIdOperation | ProtocolNamedOperation;

/** Stage 1 — members stay `Unknown`; stage 2 validates them per operation. */
const RequestEnvelope = Schema.Struct({
	operations: Schema.Array(Schema.Unknown),
	version: Schema.Literal(1),
});

/**
 * Stage 2 — the kind-independent operation base. EXACTLY the fields fate's
 * assert checks for every operation (`id`, `kind`, `select`, and `args` when
 * present — `Schema.Record` rejects arrays, matching fate's `isRecord`), plus
 * `input` as an unvalidated passthrough (fate never checks it; declaring it
 * `Unknown` cannot reject, it only keeps the field through the strip).
 * `ids`/`name`/`type` are deliberately ABSENT: validating them here would be
 * stricter than fate for kinds that do not use them.
 */
const OperationBase = Schema.Struct({
	args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	id: Schema.String,
	input: Schema.optionalKey(Schema.Unknown),
	kind: Schema.Literals(PROTOCOL_OPERATION_KINDS),
	select: Schema.Array(Schema.String),
});

const ByIdFields = Schema.Struct({
	ids: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
	type: Schema.String,
});

const NamedFields = Schema.Struct({
	name: Schema.String,
});

const decodeEnvelope = Schema.decodeUnknownEffect(RequestEnvelope);
const decodeBase = Schema.decodeUnknownEffect(OperationBase);
const decodeByIdFields = Schema.decodeUnknownEffect(ByIdFields);
const decodeNamedFields = Schema.decodeUnknownEffect(NamedFields);

const badRequest = (message: string) => (): FateRequestError =>
	new FateRequestError("BAD_REQUEST", message);

const decodeOperation = (
	value: unknown,
): Effect.Effect<DecodedProtocolOperation, FateRequestError> =>
	Effect.gen(function* () {
		const base = yield* decodeBase(value).pipe(
			Effect.mapError(badRequest("Invalid Fate protocol operation.")),
		);
		if (base.kind === "byId") {
			const fields = yield* decodeByIdFields(value).pipe(
				Effect.mapError(badRequest("Invalid Fate byId operation.")),
			);
			return {
				kind: base.kind,
				id: base.id,
				select: base.select,
				...(base.args !== undefined ? {args: base.args} : {}),
				type: fields.type,
				ids: fields.ids,
			};
		}
		const fields = yield* decodeNamedFields(value).pipe(
			Effect.mapError(badRequest("Invalid Fate named operation.")),
		);
		return {
			kind: base.kind,
			id: base.id,
			select: base.select,
			...(base.args !== undefined ? {args: base.args} : {}),
			...(base.input !== undefined ? {input: base.input} : {}),
			name: fields.name,
		};
	});

/**
 * fate's `assertProtocolRequest` as an Effect. `concurrency: 1` is required,
 * not incidental: operations validate in order, first failure wins, matching
 * fate's loop.
 */
export const decodeProtocolRequest = (
	body: unknown,
): Effect.Effect<ReadonlyArray<DecodedProtocolOperation>, FateRequestError> =>
	Effect.gen(function* () {
		const envelope = yield* decodeEnvelope(body).pipe(
			Effect.mapError(badRequest("Invalid Fate protocol request.")),
		);
		return yield* Effect.forEach(envelope.operations, decodeOperation, {concurrency: 1});
	});

const encodeResponse = Schema.encodeEffect(ProtocolResponse);

/** Total for values the interpreter constructs, so an encode failure dies. */
export const encodeProtocolResponse = (
	value: (typeof ProtocolResponse)["Type"],
): Effect.Effect<(typeof ProtocolResponse)["Encoded"]> => encodeResponse(value).pipe(Effect.orDie);
