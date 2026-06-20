/**
 * The fate wire-error `code` vocabulary — the one canonical name for the error
 * `code` string that crosses the worker↔SPA boundary.
 *
 * The worker derives these from the `ErrorCode` annotations on its error
 * classes (`@kampus/fate-effect`'s `encodeWireError`, `.patterns/fate-effect-wire-errors.md`);
 * the SPA narrows incoming codes to this union with {@link decodeFateWireCode}
 * so UI code can `switch` on a typed value instead of stringly comparing
 * against `"UNAUTHORIZED"` etc. The literal tuple is the authored source — a
 * runtime `Set<string>` (what the server's `declaredWireCodes` walk yields)
 * cannot give an exhaustive-`switch`-able union, so the SPA carries the literal
 * and the worker's `wireCodes.unit.test.ts` derives `declaredWireCodes(fateConfig)`
 * and fails CI if this list omits any code the server can emit — the two ends of
 * the wire contract are bound by that guard, not by hope.
 *
 * This module lives under `src/lib/` and is cross-included by the worker
 * tsconfig so both halves of the codec — and the coverage guard — agree on the
 * same constant.
 */
export const FATE_WIRE_CODES = [
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
	// Pano taslak (draft-save) is gated on the `pano-draft-save` flag; the server
	// raises this when a draft mutation runs with the flag off (#746).
	"DRAFTS_DISABLED",
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

/** The fate wire-error `code` — one name for the concept across the seam. */
export type FateWireCode = (typeof FATE_WIRE_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(FATE_WIRE_CODES);

/**
 * Narrow a wire-format `extensions.code` string to a {@link FateWireCode}.
 * Returns `null` for unrecognized codes (including `undefined` / `null`) so
 * the caller can fall through to a generic handler.
 */
export function decodeFateWireCode(code: unknown): FateWireCode | null {
	if (typeof code !== "string") return null;
	return KNOWN_CODES.has(code) ? (code as FateWireCode) : null;
}
