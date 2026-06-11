/**
 * The wire contract for mutation-error `code` strings.
 * The worker derives these from the `ErrorCode` annotations on its error
 * classes (`@phoenix/fate-effect`'s `encodeWireError`); the SPA
 * `decodeMutationErrorCode` decoder narrows incoming codes to this union so
 * UI code can `switch` on a typed value instead of stringly comparing against
 * `"UNAUTHORIZED"` etc.
 *
 * This module lives under `src/lib/` and is cross-included by the worker
 * tsconfig so both halves of the codec agree on the same constant.
 */
export const MUTATION_ERROR_CODES = [
	"UNAUTHORIZED",
	"DEFINITION_NOT_FOUND",
	"POST_NOT_FOUND",
	"COMMENT_NOT_FOUND",
	// Schema rejection of an operation's input/args (`InputValidationError`,
	// the code fate's own schema validation also emits). Pre-handler, so any
	// mutation can surface it.
	"VALIDATION_ERROR",
	// Validation codes (per-domain `code` string, upcased).
	"BODY_REQUIRED",
	"BODY_TOO_LONG",
	"TITLE_REQUIRED",
	"TITLE_TOO_LONG",
	"URL_INVALID",
	"TAGS_REQUIRED",
	"TAG_INVALID",
	"PARENT_NOT_FOUND",
	"INVALID_FORMAT",
	"TOO_SHORT",
	"TOO_LONG",
	"ALREADY_SET",
	"TAKEN",
	"USER_NOT_FOUND",
	"BAD_REQUEST",
	"INTERNAL_SERVER_ERROR",
] as const;

export type MutationErrorCode = (typeof MUTATION_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(MUTATION_ERROR_CODES);

/**
 * Narrow a wire-format `extensions.code` string to a {@link MutationErrorCode}.
 * Returns `null` for unrecognized codes (including `undefined` / `null`) so
 * the caller can fall through to a generic handler.
 */
export function decodeMutationErrorCode(code: unknown): MutationErrorCode | null {
	if (typeof code !== "string") return null;
	return KNOWN_CODES.has(code) ? (code as MutationErrorCode) : null;
}
