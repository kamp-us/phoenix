/**
 * The `FateWireCode` annotation key and the wire-error codec. See ADR 0241.
 *
 * One edit per domain error, no registry: a feature attaches its wire code as
 * a schema annotation and {@link encodeWireError} derives the wire error from
 * it —
 *
 * ```ts
 * class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
 *   "sozluk/BodyRequired",
 *   {message: Schema.String},
 *   {[FateWireCode]: "BODY_REQUIRED"},
 * ) {}
 * ```
 *
 * Annotations are the documented effect extension point: effect-smol
 * `Schema.ts` › `Annotations` namespace ("Defining your own annotations"). A
 * `Schema.TaggedErrorClass`'s annotations land on the class's static
 * `ast.annotations`, so the codec reads them off `instance.constructor` with
 * structural guards — no registry lookup, no type assertion.
 *
 * Defect details (driver errors, stack fragments) never leak onto the wire:
 * anything un-annotated encodes to {@link INTERNAL_WIRE_CODE} plus a fixed
 * message.
 */
import {FateRequestError} from "@nkzw/fate/server";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

/**
 * The annotation key. The string value must stay `fate-effect/wireCode` — it
 * is the augmentation key the annotation is stored under below.
 */
export const FateWireCode = "fate-effect/wireCode";

declare module "effect/Schema" {
	namespace Annotations {
		interface Annotations {
			readonly "fate-effect/wireCode"?: string | undefined;
		}
	}
}

/**
 * `INTERNAL_SERVER_ERROR`, not fate's protocol `INTERNAL_ERROR`, on purpose —
 * this is the code the SPA's `FATE_WIRE_CODES` contract decodes.
 */
export const INTERNAL_WIRE_CODE = "INTERNAL_SERVER_ERROR";

const INTERNAL_WIRE_MESSAGE = "Something went wrong.";

/**
 * fate's OWN internal arm, distinct from {@link INTERNAL_WIRE_CODE}: what fate
 * spells for walk-internal throws and request-level defects. These bytes are
 * pinned by the walk oracle, and this is the ONE construction site — `Walk.ts`,
 * `Connection.ts` and `Interpreter.ts` all derive from it so the arms cannot
 * drift apart.
 */
export const internalArm = (): FateRequestError =>
	new FateRequestError("INTERNAL_ERROR", "Internal server error.");

/** The typed failure behind a `Cause` if there is one, else the squashed defect. */
export const failureOf = (cause: Cause.Cause<unknown>): unknown =>
	Option.match(Cause.findErrorOption(cause), {
		onSome: (error) => error,
		onNone: () => Cause.squash(cause),
	});

/** fate's closed `FateProtocolErrorCode`, which it doesn't export by name. */
type FateProtocolErrorCode = ConstructorParameters<typeof FateRequestError>[0];

/**
 * The cast is deliberate: fate types `code` as its narrow protocol union but at
 * runtime stores and forwards whatever string it is given, and phoenix's wire
 * vocabulary (`BODY_REQUIRED`, `TAKEN`, …) is wider.
 */
function makeWireError(code: string, message: string): FateRequestError {
	return new FateRequestError(code as FateProtocolErrorCode, message);
}

/**
 * A schema class's annotations live on its static `ast.annotations`. Structural
 * guarding throughout, so arbitrary values are safe inputs.
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

export function wireCodeOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return wireCodeOfClass(value.constructor);
}

/** Total: never throws, whatever the input. */
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
