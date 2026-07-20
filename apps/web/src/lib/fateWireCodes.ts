/**
 * The fate wire-error `code` vocabulary — the one canonical name for the error
 * `code` string that crosses the worker↔SPA boundary.
 *
 * The worker derives these from the `FateWireCode` annotations on its error
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
	// The earned-ladder (Level) denial — actor's standing is below a right's floor
	// (`kunye/RequiresLevel`, ADR 0107). First surfaced on the wire by `user.vouch`
	// (#1206): a non-yazar vouch attempt. Distinct from `UNAUTHORIZED` (the invisible
	// ReBAC/moderation denial) — FORBIDDEN is the visible-progression public ladder.
	"FORBIDDEN",
	// The earn-to-vote denial — a çaylak (below the yazar floor) cast a vote on live
	// content (`vote/VoterNotEligible`, ADR 0096 / #1810/#1828). Distinct from the
	// overloaded `FORBIDDEN` (künye vouch denials) so the vote gate gets its own ladder
	// copy without mislabelling other forbiddens (#1879): "yazar olunca oy verebilirsin".
	"VOTE_REQUIRES_YAZAR",
	// The self-vote denial — a voter cast on their OWN content (`vote/SelfVoteNotAllowed`,
	// #2216, founder-ruled). The client hides the vote control on one's own content, so this
	// is defense-in-depth: it reaches the wire only if that affordance is bypassed.
	"SELF_VOTE_NOT_ALLOWED",
	// The concurrent-vouch cap (D5) is reached — a yazar already holds the maximum
	// active vouches (`kunye/VouchLimitReached`, #1289). Past the `FORBIDDEN` yazar
	// floor: the actor IS a yazar, the act is just rationed.
	"VOUCH_LIMIT_REACHED",
	// A karma-VALUE privilege floor failed — the actor's earned `total_karma` is
	// below a right's minimum (`kunye/InsufficientKarma`, #150): posting (≥ −4) or
	// flagging (≥ 50). Distinct from the tier-ladder `FORBIDDEN` — this is a raw
	// karma-count anti-abuse floor, a separate axis (no double-gating, #150 rescope).
	"INSUFFICIENT_KARMA",
	// The per-actor mutation throttle tripped — the actor is issuing writes faster
	// than their token bucket refills (`throttle/RateLimitExceeded`, ADR 0177).
	// Cross-cutting: injected at the fate mutation seam, so ANY mutation can surface
	// it. Not in `declaredWireCodes` (no declared union carries it); the coverage
	// guard unions `THROTTLE_WIRE_CODES` so this list must still cover it.
	"RATE_LIMIT_EXCEEDED",
	"DEFINITION_NOT_FOUND",
	"POST_NOT_FOUND",
	// A pano post's removal WRITE failed at the D1 layer (`pano/PostDeleteFailed`,
	// #1639) — the declared, user-readable failure `post.delete` raises instead of
	// letting a squashed removal-commit defect escape as `INTERNAL_SERVER_ERROR`.
	"POST_DELETE_FAILED",
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
	// A görünen-ad (display-name) save submitted an empty/whitespace-only value
	// (`pasaport/DisplayNameEmpty`, #2154) — the server-authoritative floor the
	// worker `user.setDisplayName` write-through raises against a blank byline.
	"DISPLAY_NAME_EMPTY",
	// A ban submitted without a reason (`pasaport/BanReasonRequired`, #970) — the
	// server-authoritative floor the admin `user.banUser` mutation raises against a
	// blank gerekçe, since a ban's audit record is meaningless without one.
	"BAN_REASON_REQUIRED",
	// A manual failing-address mark submitted without a reason
	// (`pasaport/EmailFailingReasonRequired`, #2692) — the server-authoritative floor the
	// admin `emailDelivery.mark` mutation raises against a blank note, since the audit
	// record of why an address was marked failing out-of-band is meaningless without one.
	"EMAIL_FAILING_REASON_REQUIRED",
	// mecmua write path is gated on the `mecmua-write` flag; the server raises this
	// when `mecmua.publish` / `mecmua.saveDraft` run with the flag off (#2497).
	"MECMUA_DISABLED",
	// A `mecmua.publish` target draft doesn't exist or isn't the caller's own
	// (`mecmua/MecmuaPostNotFound`, #2497) — the ownership-scoped miss.
	"MECMUA_POST_NOT_FOUND",
	// member-mute write path is gated on the `member-mute` flag; the server raises this
	// when `mute.set` / `mute.remove` run with the flag off (#3112).
	"MUTE_DISABLED",
	// A member tried to mute themselves (`mute/SelfMuteRejected`, #3112) — the domain
	// refuses a self-mute before any write.
	"SELF_MUTE_REJECTED",
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
