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
 * registry keyed by the union of every tagged-error `_tag` raised by an
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
 * new tagged error and importing it here widens this union, which forces a
 * matching {@link WIRE_CODE_BY_TAG} entry (see below).
 */
export type FateErrorTag =
	// Auth / infra
	| Unauthorized["_tag"]
	| DrizzleError["_tag"]
	// Pasaport — `UsernameInvalid` is a union alias over the per-code classes
	// since the pasaport migration, so it contributes its members' tags (one
	// registry row per class below), same as the pano aliases.
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
	// Pano — `PostValidation`/`CommentValidation` are union aliases over the
	// per-code classes since the pano migration, so each contributes its
	// members' tags (one registry row per class below).
	| PostValidation["_tag"]
	| CommentValidation["_tag"]
	| PostNotFound["_tag"]
	| CommentNotFound["_tag"]
	| UnauthorizedPostMutation["_tag"]
	| UnauthorizedCommentMutation["_tag"];

/**
 * The runtime payload `encodeFateError` reads off a tagged error. Only
 * `message` is consulted; everything else on a given error class is for
 * logging, not the wire.
 */
type TaggedErrorShape = {readonly message?: string};

/**
 * A registry value: the function that turns one tagged error instance into its
 * wire error, paired with the closed set of wire `code`s that function can
 * produce. The `codes` list is what {@link WIRE_CODES} aggregates — so the set of
 * codes the server can emit is *derived from the registry*, not hand-kept, and
 * the SPA-list guard (`mutationErrorCodes.test.ts`) checks against it.
 */
interface WireCodeFor {
	readonly encode: (e: TaggedErrorShape) => FateRequestError;
	readonly codes: ReadonlyArray<MutationErrorCode>;
}

/**
 * Static-code arm: one wire code, one fixed (or carried) message. The
 * bridge-era `upcased` arm (the wire code derived from an instance `code`
 * field) retired with the pasaport migration — its last consumer — when the
 * validation classes split one-per-code (`pasaport/errors.ts`,
 * `pano/errors.ts`).
 */
const fixed = (code: MutationErrorCode, fallback: string): WireCodeFor => ({
	encode: (e) => fateError(code, e.message ?? fallback),
	codes: [code],
});

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
	// Dead but type-forced (same story as the pano rows below): pasaport
	// migrated onto the fate-effect annotations (`pasaport/errors.ts`
	// `fateWireCode`, pinned by `pasaport/errors.unit.test.ts`). The former
	// `upcased` arm's dynamic sub-codes are now one per-code class each, hence
	// one `fixed` row each.
	"pasaport/UsernameInvalidFormat": fixed("INVALID_FORMAT", "validation failed"),
	"pasaport/UsernameTooShort": fixed("TOO_SHORT", "validation failed"),
	"pasaport/UsernameTooLong": fixed("TOO_LONG", "validation failed"),
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
	// Dead but type-forced: pano migrated onto the fate-effect annotations
	// (`pano/errors.ts` `fateWireCode`, pinned by `pano/errors.unit.test.ts`),
	// so no legacy record can raise these tags anymore — but `FateErrorTag`
	// still derives them from the classes, so the rows stay until the registry
	// dies with the bridge (task 13). The former `upcased` arms' dynamic
	// sub-codes are now one per-code class each, hence one `fixed` row each;
	// keeping them here also keeps {@link WIRE_CODES} covering the full pano
	// vocabulary for the SPA-list guard.
	"pano/TitleRequired": fixed("TITLE_REQUIRED", "validation failed"),
	"pano/TitleTooLong": fixed("TITLE_TOO_LONG", "validation failed"),
	"pano/UrlInvalid": fixed("URL_INVALID", "validation failed"),
	"pano/PostBodyTooLong": fixed("BODY_TOO_LONG", "validation failed"),
	"pano/TagsRequired": fixed("TAGS_REQUIRED", "validation failed"),
	"pano/TagInvalid": fixed("TAG_INVALID", "validation failed"),
	"pano/CommentBodyRequired": fixed("BODY_REQUIRED", "validation failed"),
	"pano/CommentBodyTooLong": fixed("BODY_TOO_LONG", "validation failed"),
	"pano/ParentCommentNotFound": fixed("PARENT_NOT_FOUND", "validation failed"),
	"pano/PostNotFound": fixed("POST_NOT_FOUND", "post not found"),
	"pano/CommentNotFound": fixed("COMMENT_NOT_FOUND", "comment not found"),
	"pano/UnauthorizedPostMutation": fixed("UNAUTHORIZED", "not authorized"),
	"pano/UnauthorizedCommentMutation": fixed("UNAUTHORIZED", "not authorized"),
};

/**
 * The always-present wire `code` `encodeFateError` can emit independent of any
 * registry arm: `INTERNAL_SERVER_ERROR` (the unknown / non-tagged fallback).
 * (`BAD_REQUEST` left this list with the `upcased` arm — it now reaches the
 * wire only through the vote row above.)
 */
const FALLBACK_WIRE_CODES = ["INTERNAL_SERVER_ERROR"] as const;

/**
 * The closed set of wire `code`s the server can put on the wire — every arm's
 * declared {@link WireCodeFor.codes} plus the always-present
 * {@link FALLBACK_WIRE_CODES}. Derived from {@link WIRE_CODE_BY_TAG}, so it can't
 * drift from the encoder. The SPA's `MUTATION_ERROR_CODES` list must cover this
 * set or an emitted code silently decodes to the SPA's `INTERNAL_SERVER_ERROR`
 * fallback; `mutationErrorCodes.test.ts` guards that.
 */
export const WIRE_CODES: ReadonlySet<MutationErrorCode> = new Set<MutationErrorCode>([
	...FALLBACK_WIRE_CODES,
	...Object.values(WIRE_CODE_BY_TAG).flatMap((arm) => arm.codes),
]);

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
		return WIRE_CODE_BY_TAG[tag as FateErrorTag].encode(e ?? {});
	}

	return fateError("INTERNAL_SERVER_ERROR", e?.message ?? "Something went wrong.");
}
