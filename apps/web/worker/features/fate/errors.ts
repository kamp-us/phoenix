/**
 * fate ↔ wire error codec.
 *
 * The bridge's runner ({@link ../effect.ts}) invokes {@link encodeFateError} in
 * its catch path: every tagged domain failure surfaced from a resolver or
 * source executor is mapped onto a {@link FateRequestError}, which fate
 * serializes to `{ok: false, error: {code, message, issues?}}` on the wire.
 *
 * The wire `code` is a `mutationErrorCode` string the SPA decodes with the
 * `decodeMutationErrorCode` narrowing ({@link ../../src/lib/mutationErrorCodes.ts}).
 * The error codes are the shared contract between worker and SPA.
 *
 * Matching strategy
 * -----------------
 * The encoder dispatches on **`_tag`** through {@link WIRE_CODE_BY_TAG} — a
 * registry keyed by the union of every `Data.TaggedError` `_tag` raised by an
 * Effect service (`Sozluk`, `Pano`, `Vote`, `Pasaport`, `Drizzle`, `Auth`).
 * The key type {@link FateErrorTag} is *derived from the error
 * classes themselves*, so the registry is `Record<FateErrorTag, …>`: add a new
 * tagged error and forget its entry, and the literal stops typechecking. The
 * compiler — not convention — enforces the `_tag` → wire-code link, killing the
 * silent `INTERNAL_SERVER_ERROR` downgrade a missing switch arm used to cause.
 *
 * A `FateRequestError` already on the wire-shape passes through verbatim —
 * that's the escape hatch for resolver-side validation that already knows its
 * code. Genuinely unknown / non-tagged throws still default to
 * `INTERNAL_SERVER_ERROR`.
 *
 * Widening the error code
 * -----------------------
 * `FateRequestError`'s constructor types `code` as `FateProtocolErrorCode` — a
 * closed 6-member protocol union (`BAD_REQUEST | FORBIDDEN | INTERNAL_ERROR |
 * NOT_FOUND | UNAUTHORIZED | VALIDATION_ERROR`). phoenix's wire vocabulary is
 * the wider `MutationErrorCode` set (`BODY_REQUIRED`, `TAKEN`, …). At runtime
 * the constructor stores whatever string it's given and fate forwards it on the
 * wire untouched, so we widen the constructor through {@link fateError} — a thin
 * typed wrapper that accepts any `MutationErrorCode`. Documented in
 * `.patterns/fate-effect-bridge.md`.
 */
import {FateRequestError} from "@nkzw/fate/server";
import type {MutationErrorCode} from "../../../src/lib/mutationErrorCodes.ts";
import type {DrizzleError} from "../../db/Drizzle.ts";
import type {
	CommentNotFound,
	CommentValidation,
	PostNotFound,
	PostValidation,
	UnauthorizedCommentMutation,
	UnauthorizedPostMutation,
} from "../pano/errors.ts";
import type {Unauthorized} from "../pasaport/Auth.ts";
import type {
	UserNotFound,
	UsernameAlreadySet,
	UsernameInvalid,
	UsernameTaken,
} from "../pasaport/errors.ts";
import type {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "../sozluk/errors.ts";
import type {VoteTargetNotFound} from "../vote/errors.ts";

// The wire-side constant + decoder live in `src/lib/` so the SPA can import
// them without crossing the worker boundary; re-exported here so worker callers
// don't need to know where the contract is physically defined.
export {
	decodeMutationErrorCode,
	MUTATION_ERROR_CODES,
	type MutationErrorCode,
} from "../../../src/lib/mutationErrorCodes.ts";

/**
 * Construct a `FateRequestError` carrying a phoenix `MutationErrorCode` as its
 * wire `code`. Widens fate's narrow `FateProtocolErrorCode` constructor — see
 * the note above.
 */
/**
 * The exact type of `FateRequestError`'s `code` constructor parameter (fate's
 * narrow `FateProtocolErrorCode`, which the package doesn't export by name).
 * Captured structurally so we can widen into it without an unimportable type
 * reference and without a laundering `as never`/`as unknown` cast.
 */
type FateWireCode = ConstructorParameters<typeof FateRequestError>[0];

function fateError(code: MutationErrorCode, message: string): FateRequestError {
	// `FateRequestError`'s constructor types `code` as the narrow 6-member
	// `FateProtocolErrorCode`; phoenix's wire vocabulary is the wider
	// `MutationErrorCode`. At runtime the constructor just stores the string and
	// fate forwards it on the wire untouched (see the module header). The two
	// unions overlap (`BAD_REQUEST`/`UNAUTHORIZED`), so this is a single
	// comparable narrowing cast to the parameter's own type — not a laundering
	// `as never`/`as unknown` double-cast.
	return new FateRequestError(code as FateWireCode, message);
}

/**
 * The union of every domain/infra `_tag` `encodeFateError` is expected to map.
 *
 * Derived from the error classes (`InstanceType<typeof X>["_tag"]`) rather than
 * hand-written, so it can't drift from the classes it claims to cover. Adding a
 * new `Data.TaggedError` and importing it here widens this union, which forces a
 * matching {@link WIRE_CODE_BY_TAG} entry (see below).
 */
export type FateErrorTag =
	// Auth / infra
	| Unauthorized["_tag"]
	| DrizzleError["_tag"]
	// Pasaport
	| UsernameInvalid["_tag"]
	| UsernameTaken["_tag"]
	| UsernameAlreadySet["_tag"]
	| UserNotFound["_tag"]
	// Vote
	| VoteTargetNotFound["_tag"]
	// Sozluk
	| BodyRequired["_tag"]
	| BodyTooLong["_tag"]
	| DefinitionNotFound["_tag"]
	| UnauthorizedDefinitionMutation["_tag"]
	// Pano
	| PostValidation["_tag"]
	| CommentValidation["_tag"]
	| PostNotFound["_tag"]
	| CommentNotFound["_tag"]
	| UnauthorizedPostMutation["_tag"]
	| UnauthorizedCommentMutation["_tag"];

/**
 * The runtime payload `encodeFateError` reads off a tagged error. Only `code`
 * (carried by the validation tags) and `message` are consulted; everything else
 * on a given error class is for logging, not the wire.
 */
type TaggedErrorShape = {readonly code?: string; readonly message?: string};

/** A registry value: turns one tagged error instance into its wire error. */
type WireCodeFor = (e: TaggedErrorShape) => FateRequestError;

/** Static-code arm: one wire code, one fixed (or carried) message. */
const fixed =
	(code: MutationErrorCode, fallback: string): WireCodeFor =>
	(e) =>
		fateError(code, e.message ?? fallback);

/**
 * Dynamic-code arm: the wire code is the error's own `code` field upcased
 * (`title_required` → `TITLE_REQUIRED`), defaulting to `BAD_REQUEST`. Backs the
 * validation tags whose sub-code lives on the instance.
 */
const upcased =
	(fallbackMessage: string): WireCodeFor =>
	(e) => {
		const upper = (e.code ? e.code.toUpperCase() : "BAD_REQUEST") as MutationErrorCode;
		return fateError(upper, e.message ?? fallbackMessage);
	};

/**
 * The `_tag` → wire-code registry. Typed `Record<FateErrorTag, WireCodeFor>`,
 * so a `FateErrorTag` member with no entry is a **compile error** — this is the
 * exhaustiveness gate. The `FateRequestError` pass-through and the unknown /
 * non-tagged default live in {@link encodeFateError}, not here.
 */
export const WIRE_CODE_BY_TAG: Record<FateErrorTag, WireCodeFor> = {
	// ── Auth / infra ──────────────────────────────────────────────────────
	Unauthorized: fixed("UNAUTHORIZED", "not authorized"),
	"@phoenix/Drizzle/Error": fixed("INTERNAL_SERVER_ERROR", "internal error"),

	// ── Pasaport ────────────────────────────────────────────────────────────
	// `code` on `UsernameInvalid` is upcased to the wire contract
	// (INVALID_FORMAT / TOO_SHORT / TOO_LONG).
	"pasaport/UsernameInvalid": upcased("validation failed"),
	"pasaport/UsernameTaken": fixed("TAKEN", "bu kullanıcı adı kullanımda"),
	"pasaport/UsernameAlreadySet": fixed(
		"ALREADY_SET",
		"kullanıcı adı zaten ayarlandı; değiştirilemez",
	),
	"pasaport/UserNotFound": fixed("USER_NOT_FOUND", "kullanıcı bulunamadı"),

	// ── Vote ──────────────────────────────────────────────────────────────
	"vote/VoteTargetNotFound": fixed("BAD_REQUEST", "vote target not found"),

	// ── Sozluk ────────────────────────────────────────────────────────────
	"sozluk/BodyRequired": fixed("BODY_REQUIRED", "tanım boş olamaz"),
	"sozluk/BodyTooLong": fixed("BODY_TOO_LONG", "tanım çok uzun"),
	"sozluk/DefinitionNotFound": fixed("DEFINITION_NOT_FOUND", "definition not found"),
	"sozluk/UnauthorizedDefinitionMutation": fixed("UNAUTHORIZED", "not authorized"),

	// ── Pano ──────────────────────────────────────────────────────────────
	"pano/PostValidation": upcased("validation failed"),
	"pano/CommentValidation": upcased("validation failed"),
	"pano/PostNotFound": fixed("POST_NOT_FOUND", "post not found"),
	"pano/CommentNotFound": fixed("COMMENT_NOT_FOUND", "comment not found"),
	"pano/UnauthorizedPostMutation": fixed("UNAUTHORIZED", "not authorized"),
	"pano/UnauthorizedCommentMutation": fixed("UNAUTHORIZED", "not authorized"),
};

/**
 * Map any thrown / failed value from inside a resolver or source executor onto
 * a `FateRequestError` with a stable wire-format `code`. Idempotent on inputs
 * that are already `FateRequestError`.
 */
export function encodeFateError(err: unknown): FateRequestError {
	if (err instanceof FateRequestError) return err;

	const e = err as (Error & {code?: string; _tag?: string}) | null | undefined;
	const tag = e?._tag;

	if (typeof tag === "string" && tag in WIRE_CODE_BY_TAG) {
		return WIRE_CODE_BY_TAG[tag as FateErrorTag](e ?? {});
	}

	return fateError("INTERNAL_SERVER_ERROR", e?.message ?? "Something went wrong.");
}
