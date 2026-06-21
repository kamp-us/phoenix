/**
 * The `FateWireCode` annotation key and the wire-error codec.
 *
 * One edit per domain error, no registry: a feature defines its error class
 * with the wire code attached as a schema annotation —
 *
 * ```ts
 * class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
 *   "sozluk/BodyRequired",
 *   {message: Schema.String},
 *   {[FateWireCode]: "BODY_REQUIRED"},
 * ) {}
 * ```
 *
 * — and {@link encodeWireError} derives the fate wire error
 * (`FateRequestError`, serialized by fate as `{ok: false, error: {code,
 * message}}`) from the annotation. This replaces the bridge's hand-maintained
 * `WIRE_CODE_BY_TAG` registry (three edits per error) with the class
 * declaration itself.
 *
 * Annotations are the documented effect extension point: effect-smol
 * `Schema.ts` › `Annotations` namespace ("Defining your own annotations")
 * shows exactly this shape — a custom string key declared via module
 * augmentation, attached at definition time, read back at runtime. A
 * `Schema.TaggedErrorClass`'s annotations land on the class's static
 * `ast.annotations`, so the codec reads them off `instance.constructor` with
 * structural guards — no registry lookup, no type assertion.
 *
 * Failure taxonomy on the wire:
 *
 *   - **annotated error** → its annotated code + its own `message`. Declared
 *     domain errors are user-facing by definition.
 *   - **un-annotated error / defect** → {@link INTERNAL_WIRE_CODE} with a
 *     fixed message. Defects are bugs or infra failures; their details
 *     (driver errors, stack fragments) never leak onto the wire.
 *   - **`FateRequestError`** → passed through verbatim, the escape hatch for
 *     code that already speaks the wire shape (parity with the bridge).
 */
import {FateRequestError} from "@nkzw/fate/server";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

/**
 * The annotation key. Declared on `Schema.Annotations.Annotations` below so
 * definition sites get `string | undefined` typing for the value. The constant
 * is `FateWireCode` — the one canonical noun for this concept across the
 * worker↔SPA seam (#851, #1032); the string value stays `fate-effect/wireCode`
 * because it is the augmentation key the annotation is stored under.
 */
export const FateWireCode = "fate-effect/wireCode";

declare module "effect/Schema" {
	namespace Annotations {
		interface Annotations {
			/**
			 * The fate wire `code` this error class maps to. Set it on a
			 * `Schema.TaggedErrorClass` via the `FateWireCode` key; the
			 * fate-effect codec derives the wire error from it.
			 */
			readonly "fate-effect/wireCode"?: string | undefined;
		}
	}
}

/**
 * The wire code for everything that is not a declared, annotated error:
 * un-annotated failures and defects. `INTERNAL_SERVER_ERROR` (not fate's
 * protocol `INTERNAL_ERROR`) on purpose — it is the code phoenix's bridge has
 * always emitted and the SPA's `FATE_WIRE_CODES` contract decodes, so
 * the package stays wire-identical with what the SPA expects.
 */
export const INTERNAL_WIRE_CODE = "INTERNAL_SERVER_ERROR";

/** The fixed internal-error message — defect details never reach the wire. */
const INTERNAL_WIRE_MESSAGE = "Something went wrong.";

/**
 * fate's OWN internal arm (`toProtocolError`'s fallback): `INTERNAL_ERROR` /
 * "Internal server error.". Distinct from {@link INTERNAL_WIRE_CODE} — that is
 * the annotation codec's arm for per-operation failures; THIS is what fate
 * spells for walk-internal throws and request-level defects. The bytes are
 * pinned by the walk oracle, and this is the ONE construction site — the walk
 * (`Walk.ts`), the connection plane (`Connection.ts`), and the interpreter's
 * request-level fallback (`Interpreter.ts`) all derive from it, so the pinned
 * bytes cannot drift between arms. Package-wide error taxonomy,
 * which is why it lives here and not in the pagination plane.
 */
export const internalArm = (): FateRequestError =>
	new FateRequestError("INTERNAL_ERROR", "Internal server error.");

/**
 * The failed/thrown value behind a `Cause` — the v1 compiler's exact branch
 * (`runResolve`): the typed failure if one exists, otherwise the squashed
 * defect. Shared here because both call sites — the interpreter's
 * dispatch loop and the oracle baseline's `runResolve` — feed the result
 * straight into {@link encodeWireError}.
 */
export const failureOf = (cause: Cause.Cause<unknown>): unknown =>
	Option.match(Cause.findErrorOption(cause), {
		onSome: (error) => error,
		onNone: () => Cause.squash(cause),
	});

/**
 * The exact type of `FateRequestError`'s `code` constructor parameter (fate's
 * closed 6-member `FateProtocolErrorCode`, which the package doesn't export
 * by name). Captured structurally so {@link makeWireError} can widen into it.
 */
type FateProtocolErrorCode = ConstructorParameters<typeof FateRequestError>[0];

/**
 * Construct a `FateRequestError` with a phoenix wire code. fate types the
 * constructor's `code` as its narrow 6-member protocol union, but at runtime
 * it stores whatever string it is given and forwards it on the wire
 * untouched; phoenix's wire vocabulary (`BODY_REQUIRED`, `TAKEN`, …) is
 * wider. A single comparable narrowing cast to the parameter's own type —
 * the same documented widening the retired bridge used — not a laundering
 * double-cast.
 */
function makeWireError(code: string, message: string): FateRequestError {
	return new FateRequestError(code as FateProtocolErrorCode, message);
}

/**
 * Read the `FateWireCode` annotation off an error *class* (or anything —
 * non-classes and un-annotated classes yield `undefined`). A schema class's
 * annotations live on its static `ast.annotations`; everything here is
 * structural guarding, so arbitrary values are safe inputs.
 */
export function wireCodeOfClass(ctor: unknown): string | undefined {
	if (typeof ctor !== "function") return undefined;
	if (!Predicate.hasProperty(ctor, "ast")) return undefined;
	const ast: unknown = ctor.ast;
	if (!Predicate.hasProperty(ast, "annotations")) return undefined;
	const annotations: unknown = ast.annotations;
	if (!Predicate.hasProperty(annotations, FateWireCode)) return undefined;
	const code: unknown = annotations[FateWireCode];
	return typeof code === "string" ? code : undefined;
}

/**
 * Read the `FateWireCode` annotation off an error *instance*, via its
 * constructor. `undefined` for primitives and un-annotated values.
 */
export function wireCodeOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return wireCodeOfClass(value.constructor);
}

/**
 * Map any failed/thrown value onto the fate wire error. Total: never throws,
 * regardless of input. See the module header for the failure taxonomy.
 */
export function encodeWireError(error: unknown): FateRequestError {
	if (error instanceof FateRequestError) return error;

	const code = wireCodeOf(error);
	if (code === undefined) return makeWireError(INTERNAL_WIRE_CODE, INTERNAL_WIRE_MESSAGE);

	const message =
		Predicate.hasProperty(error, "message") && typeof error.message === "string"
			? error.message
			: INTERNAL_WIRE_MESSAGE;
	return makeWireError(code, message);
}
