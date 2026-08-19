/**
 * The fate wire-error `code` vocabulary — the one canonical name for the error
 * `code` string that crosses the worker↔SPA boundary. See
 * `.patterns/fate-effect-wire-errors.md`.
 *
 * The literal tuple is the authored source on purpose: a runtime `Set<string>`
 * (what the server's `declaredWireCodes` walk yields) cannot give an
 * exhaustive-`switch`-able union. The worker's `wireCodes.unit.test.ts` fails CI
 * if this list omits a code the server can emit, which is what binds the two ends.
 *
 * Lives under `src/lib/` and is cross-included by the worker tsconfig so both
 * halves of the codec — and that guard — read the same constant.
 */
export const FATE_WIRE_CODES = [
	"UNAUTHORIZED",
	// `kunye/RequiresLevel` (ADR 0107): standing below a right's floor. Distinct from
	// `UNAUTHORIZED`, which is the invisible ReBAC/moderation denial.
	"FORBIDDEN",
	// `vote/VoterNotEligible` (ADR 0096): a çaylak voted. Split out of `FORBIDDEN` so the
	// vote gate gets its own copy without mislabelling other denials (#1879).
	"VOTE_REQUIRES_YAZAR",
	// `vote/SelfVoteNotAllowed` (#2216). The client hides the control, so this reaches the
	// wire only when that affordance is bypassed.
	"SELF_VOTE_NOT_ALLOWED",
	// `kunye/VouchLimitReached` (#1289): past the yazar floor — the actor IS a yazar,
	// the act is just rationed.
	"VOUCH_LIMIT_REACHED",
	// `kunye/InsufficientKarma` (#150): a raw karma-count anti-abuse floor — posting
	// (≥ −4), flagging (≥ 50). A separate axis from the tier ladder, not double-gating.
	"INSUFFICIENT_KARMA",
	// `throttle/RateLimitExceeded` (ADR 0177), injected at the mutation seam so ANY
	// mutation can surface it. NOT in `declaredWireCodes` — the coverage guard unions
	// `THROTTLE_WIRE_CODES`, which is the only reason this list still has to carry it.
	"RATE_LIMIT_EXCEEDED",
	"DEFINITION_NOT_FOUND",
	"POST_NOT_FOUND",
	// `pano/PostDeleteFailed` (#1639): declared so a squashed removal-commit defect
	// cannot escape as `INTERNAL_SERVER_ERROR`.
	"POST_DELETE_FAILED",
	"COMMENT_NOT_FOUND",
	// `InputValidationError` — pre-handler, so any mutation can surface it.
	"VALIDATION_ERROR",
	// Per-domain validation `code` strings, upcased.
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
	// `pasaport/DisplayNameEmpty` (#2154).
	"DISPLAY_NAME_EMPTY",
	// `pasaport/BanReasonRequired` (#970): a ban's audit record is meaningless with no
	// gerekçe, so the server refuses a blank one.
	"BAN_REASON_REQUIRED",
	// `pasaport/EmailFailingReasonRequired` (#2692): same audit-record floor for an
	// out-of-band failing-address mark.
	"EMAIL_FAILING_REASON_REQUIRED",
	// The `mecmua-write` flag is off (#2497).
	"MECMUA_DISABLED",
	// `mecmua/MecmuaPostNotFound` (#2497) — an ownership-scoped miss, not just absence.
	"MECMUA_POST_NOT_FOUND",
	// The `member-mute` flag is off (#3112).
	"MUTE_DISABLED",
	// `mute/SelfMuteRejected` (#3112).
	"SELF_MUTE_REJECTED",
	"BAD_REQUEST",
	"INTERNAL_SERVER_ERROR",
] as const;

export type FateWireCode = (typeof FATE_WIRE_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(FATE_WIRE_CODES);

export function decodeFateWireCode(code: unknown): FateWireCode | null {
	if (typeof code !== "string") return null;
	return KNOWN_CODES.has(code) ? (code as FateWireCode) : null;
}
