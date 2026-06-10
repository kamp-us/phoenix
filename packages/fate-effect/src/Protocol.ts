/**
 * The v2 wire-protocol codecs — fate's protocol as Effect Schema (PRD "v2
 * backend: the native interpreter"; tasks.md task 14).
 *
 * Two codec surfaces, deliberately split the way fate itself splits them:
 *
 *   - **The canonical schemas** ({@link ProtocolOperation},
 *     {@link ProtocolRequest}, {@link ProtocolError},
 *     {@link ProtocolOperationResult}, {@link ProtocolResponse}) are fate's
 *     EXPORTED protocol types in Schema form, field for field. They are the
 *     round-trip codecs and the drift pin's subject (`Protocol.unit.test.ts`
 *     pins them against `@nkzw/fate`'s exported types — a fate upgrade that
 *     moves the protocol fails typecheck). Response structs declare fields in
 *     fate's SERIALIZATION order (`{data, id, ok}` / `{error, id, ok}` /
 *     `{code, issues, message}`): Schema encode emits keys in declaration
 *     order, which is what makes the interpreter's output byte-equal to the
 *     v1 compiled server's.
 *
 *   - **{@link decodeProtocolRequest}** is fate's `assertProtocolRequest`
 *     reproduced as a STAGED Schema decode — envelope, per-operation base,
 *     then the kind-conditional fields, each stage failing with fate's own
 *     `FateRequestError("BAD_REQUEST", <fate's exact message>)`. The staging
 *     preserves fate's LENIENCY as much as its strictness: fate checks
 *     `ids`/`type` only for `byId` operations and `name` only for named
 *     kinds, so a query carrying junk in those fields must be accepted
 *     (and ignored) here too, or the differential oracle would diverge on
 *     acceptance. That is why dispatch cannot simply decode the canonical
 *     {@link ProtocolOperation} — it is stricter than fate's runtime gate.
 *
 * The decoded result is a discriminated union ({@link ProtocolByIdOperation}
 * | {@link ProtocolNamedOperation}) so the dispatch loop cannot represent an
 * unvalidated state: a byId operation always carries `type`/`ids`, a named
 * operation always carries its `name` (possibly `""` — fate's assert lets the
 * empty string through and rejects it at dispatch time; the interpreter
 * mirrors that exactly).
 *
 * The wire `code` on {@link ProtocolError} is `Schema.String`, deliberately
 * wider than fate's closed 6-member union: phoenix's annotated wire codes
 * (`BODY_REQUIRED`, `TAKEN`, …) ride the same field (`WireError.ts`'s
 * documented widening). The drift pin substitutes fate's union back in for
 * everything else.
 */
import {FateRequestError} from "@nkzw/fate/server";
import {Effect} from "effect";
import * as Schema from "effect/Schema";

// --- the canonical schemas (the drift pin's subject) ----------------------------

/** fate's four operation kinds (`FateOperationKind`, not exported by name). */
export const PROTOCOL_OPERATION_KINDS = ["byId", "list", "mutation", "query"] as const;

/**
 * fate's `FateOperation`, field for field: ONE struct with kind-independent
 * optionality — the canonical wire shape, not the per-kind validation gate
 * (that is {@link decodeProtocolRequest}).
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

/** fate's `FateProtocolRequest`: the version-1 operations envelope. */
export const ProtocolRequest = Schema.Struct({
	operations: Schema.Array(ProtocolOperation),
	version: Schema.Literal(1),
});

/**
 * fate's `FateProtocolError` — `code` deliberately widened to `string` (see
 * the module doc). Field order is fate's `toProtocolError` literal order:
 * `{code, issues, message}` (`path` is in fate's type, never emitted by the
 * error path; kept for the pin and ordered last).
 */
export const ProtocolError = Schema.Struct({
	code: Schema.String,
	issues: Schema.optionalKey(Schema.Unknown),
	message: Schema.String,
	path: Schema.optionalKey(Schema.String),
});

/** The success arm of fate's `FateOperationResult`, in serialization order. */
export const ProtocolSuccessResult = Schema.Struct({
	data: Schema.Unknown,
	id: Schema.String,
	ok: Schema.Literal(true),
});

/** The failure arm of fate's `FateOperationResult`, in serialization order. */
export const ProtocolFailureResult = Schema.Struct({
	error: ProtocolError,
	id: Schema.String,
	ok: Schema.Literal(false),
});

/** fate's `FateOperationResult`: one per-operation wire outcome. */
export const ProtocolOperationResult = Schema.Union([ProtocolSuccessResult, ProtocolFailureResult]);

/** fate's `FateProtocolResponse`: the version-1 results envelope. */
export const ProtocolResponse = Schema.Struct({
	results: Schema.Array(ProtocolOperationResult),
	version: Schema.Literal(1),
});

/** A decoded, dispatch-ready byId operation: `type` and `ids` are guaranteed. */
export interface ProtocolByIdOperation {
	readonly kind: "byId";
	readonly id: string;
	readonly select: ReadonlyArray<string>;
	readonly args?: {readonly [key: string]: unknown};
	readonly type: string;
	readonly ids: ReadonlyArray<string | number>;
}

/**
 * A decoded, dispatch-ready named operation: `name` is guaranteed a string —
 * possibly `""`, which fate (and the interpreter) rejects at dispatch time
 * with the per-operation `BAD_REQUEST`, not at the protocol gate.
 */
export interface ProtocolNamedOperation {
	readonly kind: "list" | "mutation" | "query";
	readonly id: string;
	readonly select: ReadonlyArray<string>;
	readonly args?: {readonly [key: string]: unknown};
	readonly name: string;
	readonly input?: unknown;
}

/** What {@link decodeProtocolRequest} yields per operation. */
export type DecodedProtocolOperation = ProtocolByIdOperation | ProtocolNamedOperation;

// --- the staged request gate (fate's assertProtocolRequest) ----------------------

/**
 * Stage 1 — the envelope: fate checks `isRecord(value) && value.version === 1
 * && Array.isArray(value.operations)`; members are validated per operation in
 * stage 2, so they stay `Unknown` here.
 */
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

/** Stage 3a — what fate additionally demands of a byId operation. */
const ByIdFields = Schema.Struct({
	ids: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
	type: Schema.String,
});

/** Stage 3b — what fate additionally demands of a named operation. */
const NamedFields = Schema.Struct({
	name: Schema.String,
});

const decodeEnvelope = Schema.decodeUnknownEffect(RequestEnvelope);
const decodeBase = Schema.decodeUnknownEffect(OperationBase);
const decodeByIdFields = Schema.decodeUnknownEffect(ByIdFields);
const decodeNamedFields = Schema.decodeUnknownEffect(NamedFields);

/** Map any failure of one decode stage onto fate's exact wire error. */
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
 * fate's `assertProtocolRequest` as an Effect: a parsed request body in,
 * dispatch-ready operations out, or fate's own `FateRequestError` (the
 * interpreter serializes it exactly as fate's `handleRequest` catch does).
 * Operations validate IN ORDER, first failure wins — fate's loop.
 */
export const decodeProtocolRequest = (
	body: unknown,
): Effect.Effect<ReadonlyArray<DecodedProtocolOperation>, FateRequestError> =>
	Effect.gen(function* () {
		const envelope = yield* decodeEnvelope(body).pipe(
			Effect.mapError(badRequest("Invalid Fate protocol request.")),
		);
		return yield* Effect.forEach(envelope.operations, decodeOperation);
	});

// --- the response encoder ---------------------------------------------------------

const encodeResponse = Schema.encodeEffect(ProtocolResponse);

/**
 * Encode a response value onto the wire shape. Total for values the
 * interpreter constructs (they are built as {@link ProtocolResponse} types);
 * an encode failure is a package bug, so it dies.
 */
export const encodeProtocolResponse = (
	value: (typeof ProtocolResponse)["Type"],
): Effect.Effect<(typeof ProtocolResponse)["Encoded"]> => encodeResponse(value).pipe(Effect.orDie);
