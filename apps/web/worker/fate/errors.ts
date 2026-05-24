/**
 * fate ↔ wire error codec.
 *
 * The bridge's runner ({@link ../effect.ts}) invokes {@link encodeFateError} in
 * its catch path: every tagged domain failure surfaced from a resolver or
 * source executor is mapped onto a {@link FateRequestError}, which fate
 * serializes to `{ok: false, error: {code, message, issues?}}` on the wire.
 *
 * The wire `code` is the **same `mutationErrorCode` string** the GraphQL
 * `encodeMutationError` codec produced as `extensions.code` — the SPA decodes
 * it with the identical `decodeMutationErrorCode` narrowing
 * ({@link ../../src/lib/mutationErrorCodes.ts}). Keeping the codes byte-for-byte
 * identical is the contract: the data layer changed (GraphQL → fate), the error
 * vocabulary did not.
 *
 * Matching strategy
 * -----------------
 * The encoder switches on **`_tag`** — the contract for every `Data.TaggedError`
 * raised by an Effect service (`Sozluk`, `Pano`, `Vote`, `Pasaport`, `Drizzle`,
 * `Auth`, `AdminAuth`). One arm per tag, sorted by namespace. A
 * `FateRequestError` already on the wire-shape passes through verbatim — that's
 * the escape hatch for resolver-side validation that already knows its code.
 *
 * fate type drift (1.0.3)
 * -----------------------
 * `FateRequestError`'s constructor types `code` as `FateProtocolErrorCode` — a
 * closed 6-member protocol union (`BAD_REQUEST | FORBIDDEN | INTERNAL_ERROR |
 * NOT_FOUND | UNAUTHORIZED | VALIDATION_ERROR`). phoenix's wire vocabulary is
 * the wider `MutationErrorCode` set (`BODY_REQUIRED`, `TAKEN`, …). At runtime
 * the constructor stores whatever string it's given and fate forwards it on the
 * wire untouched, so we widen the constructor through {@link fateError} — a thin
 * typed wrapper that accepts any `MutationErrorCode`. This keeps the SPA
 * contract intact without a fork. Documented in `.patterns/fate-effect-bridge.md`.
 */
import {FateRequestError} from "@nkzw/fate/server";
import type {MutationErrorCode} from "../../src/lib/mutationErrorCodes";

// The wire-side constant + decoder live in `src/lib/` so the SPA can import
// them without crossing the worker boundary; re-exported here so worker callers
// don't need to know where the contract is physically defined.
export {
	decodeMutationErrorCode,
	MUTATION_ERROR_CODES,
	type MutationErrorCode,
} from "../../src/lib/mutationErrorCodes";

/**
 * Construct a `FateRequestError` carrying a phoenix `MutationErrorCode` as its
 * wire `code`. Widens fate's narrow `FateProtocolErrorCode` constructor — see
 * the fate-type-drift note above.
 */
function fateError(code: MutationErrorCode, message: string): FateRequestError {
	return new FateRequestError(code as never, message);
}

/**
 * Map any thrown / failed value from inside a resolver or source executor onto
 * a `FateRequestError` with a stable wire-format `code`. Idempotent on inputs
 * that are already `FateRequestError`.
 */
export function encodeFateError(err: unknown): FateRequestError {
	if (err instanceof FateRequestError) return err;

	const e = err as (Error & {code?: string; _tag?: string}) | null | undefined;
	const tag = e?._tag;

	if (typeof tag === "string") {
		switch (tag) {
			// ── Auth / infra ──────────────────────────────────────────────
			case "Unauthorized":
				return fateError("UNAUTHORIZED", "not authorized");

			case "@phoenix/AdminAuth/Forbidden":
				return fateError("UNAUTHORIZED", "admin operations forbidden");

			case "@phoenix/Drizzle/Error":
				return fateError("INTERNAL_SERVER_ERROR", "internal error");

			// ── Pasaport ──────────────────────────────────────────────────
			// `code` on `UsernameInvalid` is upcased to match the legacy
			// wire contract (INVALID_FORMAT / TOO_SHORT / TOO_LONG).
			case "pasaport/UsernameInvalid": {
				const invalidCode = (e as {code?: string} | undefined)?.code;
				const upper = (
					invalidCode ? invalidCode.toUpperCase() : "BAD_REQUEST"
				) as MutationErrorCode;
				return fateError(upper, e?.message ?? "validation failed");
			}

			case "pasaport/UsernameTaken":
				return fateError("TAKEN", e?.message ?? "bu kullanıcı adı kullanımda");

			case "pasaport/UsernameAlreadySet":
				return fateError(
					"ALREADY_SET",
					e?.message ?? "kullanıcı adı zaten ayarlandı; değiştirilemez",
				);

			case "pasaport/UserNotFound":
				return fateError("USER_NOT_FOUND", e?.message ?? "kullanıcı bulunamadı");

			// ── Vote ──────────────────────────────────────────────────────
			case "vote/VoteTargetNotFound":
				return fateError("BAD_REQUEST", e?.message ?? "vote target not found");

			// ── Sozluk ────────────────────────────────────────────────────
			case "sozluk/BodyRequired":
				return fateError("BODY_REQUIRED", e?.message ?? "tanım boş olamaz");

			case "sozluk/BodyTooLong":
				return fateError("BODY_TOO_LONG", e?.message ?? "tanım çok uzun");

			case "sozluk/DefinitionNotFound":
				return fateError("DEFINITION_NOT_FOUND", e?.message ?? "definition not found");

			case "sozluk/UnauthorizedDefinitionMutation":
				return fateError("UNAUTHORIZED", "not authorized");

			// ── Pano ──────────────────────────────────────────────────────
			case "pano/PostValidation":
			case "pano/CommentValidation": {
				const code = (e as {code?: string} | undefined)?.code;
				const upper = (code ? code.toUpperCase() : "BAD_REQUEST") as MutationErrorCode;
				return fateError(upper, e?.message ?? "validation failed");
			}

			case "pano/PostNotFound":
				return fateError("POST_NOT_FOUND", e?.message ?? "post not found");

			case "pano/CommentNotFound":
				return fateError("COMMENT_NOT_FOUND", e?.message ?? "comment not found");

			case "pano/UnauthorizedPostMutation":
			case "pano/UnauthorizedCommentMutation":
				return fateError("UNAUTHORIZED", "not authorized");
		}
	}

	return fateError("INTERNAL_SERVER_ERROR", e?.message ?? "Something went wrong.");
}
