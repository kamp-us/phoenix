/**
 * Per-class wire-code pin (unit tier), consolidated.
 *
 * Every annotated domain error class reachable from `fateConfig` is pinned to
 * the exact wire `code` it must carry, so the annotation-derived codec
 * (`.patterns/fate-effect-wire-errors.md`) and the SPA's `FATE_WIRE_CODES`
 * vocabulary can't drift through the migration — and an annotated instance
 * round-trips through `encodeWireError` to that code with its own message.
 *
 * The expected code is a *hand-authored* literal (`EXPECTED_CODE` below), an
 * oracle independent of the `FateWireCode` annotation under test — never read
 * back from `wireCodeOfClass`. That independence is load-bearing: codes are
 * legitimately shared across classes (`UNAUTHORIZED` ×4, `BODY_TOO_LONG` ×3),
 * so a set-membership check (each class carries *some* declared code) passes
 * even when a class is mis-annotated to *another* valid code. Only an oracle
 * stating which class carries WHICH code catches that. Since the annotation is
 * the sole class→code author site, asserting it against itself is a tautology;
 * the oracle is the second, independent statement of intent the pin needs.
 *
 * This is the exact code-per-class binding the aggregate guards do NOT assert:
 * `wireCodes.unit.test.ts` proves the SPA list covers `declaredWireCodes`, and
 * `packages/fate-effect/src/Server.unit.test.ts` owns the AST-walk that derives
 * those codes — neither pins WHICH class carries WHICH code. The staleness
 * guard at the bottom binds the oracle to `fateConfig` so a feature added with
 * an unpinned annotated code fails CI here instead of silently escaping
 * per-class coverage. The round-trip cases reuse the oracle's codes (single
 * source for each code) and only choose WHICH classes to instantiate.
 */

import {
	declaredWireCodes,
	encodeWireError,
	INTERNAL_WIRE_CODE,
	Unauthorized,
	wireCodeOfClass,
} from "@kampus/fate-effect";
import {describe, expect, it} from "vitest";
import {Denied, InsufficientKarma, RequiresLevel, VouchLimitReached} from "../kunye/errors.ts";
import {
	CommentBodyRequired,
	CommentBodyTooLong,
	CommentNotFound,
	DraftsDisabled,
	ParentCommentNotFound,
	PostBodyTooLong,
	PostDeleteFailed,
	PostNotFound,
	ReactionsDisabled,
	TagInvalid,
	TagsRequired,
	TitleRequired,
	TitleTooLong,
	UnauthorizedCommentMutation,
	UnauthorizedPostMutation,
	UrlInvalid,
} from "../pano/errors.ts";
import {
	DisplayNameEmpty,
	UserNotFound,
	UsernameAlreadySet,
	UsernameInvalidFormat,
	UsernameTaken,
	UsernameTooLong,
	UsernameTooShort,
} from "../pasaport/errors.ts";
import {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "../sozluk/errors.ts";
import {SelfVoteNotAllowed, VoterNotEligible} from "../vote/errors.ts";
import {fateConfig} from "./config.ts";

/**
 * The independent oracle: every annotated domain error class `fateConfig` can
 * emit, pinned to its specific wire code by a hand-authored literal. This is
 * the test's second statement of intent — the assertion compares each class's
 * `FateWireCode` annotation against THIS, never against itself. The staleness
 * guard below proves these keys cover every code in `declaredWireCodes`
 * (modulo the package-intrinsic codes), so a newly-declared annotated error
 * can't escape this per-class coverage.
 */
const EXPECTED_CODE = new Map<new (...args: never[]) => unknown, string>([
	// pano
	[TitleRequired, "TITLE_REQUIRED"],
	[TitleTooLong, "TITLE_TOO_LONG"],
	[UrlInvalid, "URL_INVALID"],
	[PostBodyTooLong, "BODY_TOO_LONG"],
	[TagsRequired, "TAGS_REQUIRED"],
	[TagInvalid, "TAG_INVALID"],
	[CommentBodyRequired, "BODY_REQUIRED"],
	[CommentBodyTooLong, "BODY_TOO_LONG"],
	[ParentCommentNotFound, "PARENT_NOT_FOUND"],
	[PostNotFound, "POST_NOT_FOUND"],
	[PostDeleteFailed, "POST_DELETE_FAILED"],
	[CommentNotFound, "COMMENT_NOT_FOUND"],
	[UnauthorizedPostMutation, "UNAUTHORIZED"],
	[UnauthorizedCommentMutation, "UNAUTHORIZED"],
	[DraftsDisabled, "DRAFTS_DISABLED"],
	[ReactionsDisabled, "REACTIONS_DISABLED"],
	// sozluk
	[BodyRequired, "BODY_REQUIRED"],
	[BodyTooLong, "BODY_TOO_LONG"],
	[DefinitionNotFound, "DEFINITION_NOT_FOUND"],
	[UnauthorizedDefinitionMutation, "UNAUTHORIZED"],
	// pasaport
	[UsernameInvalidFormat, "INVALID_FORMAT"],
	[UsernameTooShort, "TOO_SHORT"],
	[UsernameTooLong, "TOO_LONG"],
	[UsernameTaken, "TAKEN"],
	[UsernameAlreadySet, "ALREADY_SET"],
	[UserNotFound, "USER_NOT_FOUND"],
	[DisplayNameEmpty, "DISPLAY_NAME_EMPTY"],
	// künye moderation gate + the package-side gate the SPA already decodes for writes
	[Denied, "UNAUTHORIZED"],
	[Unauthorized, "UNAUTHORIZED"],
	// künye earned-ladder denial — first reachable from fateConfig via `user.vouch` (#1206).
	// Has an extra required field (`need`), so it is pinned here but NOT in ROUND_TRIP_CLASSES.
	[RequiresLevel, "FORBIDDEN"],
	// künye concurrent-vouch cap (D5, #1289) — reachable via `user.vouch` past the floor.
	// Has an extra required field (`cap`), so pinned here but NOT in ROUND_TRIP_CLASSES.
	[VouchLimitReached, "VOUCH_LIMIT_REACHED"],
	// vote earn-to-vote denial — reachable from fateConfig via the inline cast paths
	// (pano post/comment + sözlük definition), #1810/#1828/#1879. Its own distinct code
	// (not the overloaded FORBIDDEN). Has extra required fields (`voterId`, `need`), so it
	// is pinned here but NOT in ROUND_TRIP_CLASSES.
	[VoterNotEligible, "VOTE_REQUIRES_YAZAR"],
	// vote self-vote denial — reachable from fateConfig via the inline cast paths (pano
	// post + sözlük definition), #2216. Its own distinct code. Has an extra required field
	// (`voterId`), so pinned here but NOT in ROUND_TRIP_CLASSES.
	[SelfVoteNotAllowed, "SELF_VOTE_NOT_ALLOWED"],
	// künye karma-VALUE privilege floor (#150) — reachable from fateConfig via the
	// content-creation mutations (`post.submit` / `comment.add` / `definition.add`) and
	// `report.submit`. Its OWN code (not the tier-ladder FORBIDDEN). Has extra required
	// fields (`need`, `have`), so pinned here but NOT in ROUND_TRIP_CLASSES.
	[InsufficientKarma, "INSUFFICIENT_KARMA"],
]);

const ORACLE_ENTRIES = [...EXPECTED_CODE.entries()] as ReadonlyArray<[unknown, string]>;

/**
 * The subset of oracle classes whose only required field is `message`, so an
 * instance can be constructed generically here for the `encodeWireError`
 * round-trip. The codec reads the same annotation regardless of payload, so one
 * message-only representative per distinct code proves the mechanism; classes
 * with extra required fields (`postId`, `definitionId`, …) are still pinned for
 * their code by the oracle above. This list authors only WHICH classes to
 * instantiate — each expected code is looked up in the oracle (the single
 * source), never re-listed here.
 */
const ROUND_TRIP_CLASSES = [
	TitleRequired,
	TitleTooLong,
	UrlInvalid,
	PostBodyTooLong,
	TagsRequired,
	TagInvalid,
	CommentBodyRequired,
	CommentBodyTooLong,
	ParentCommentNotFound,
	PostDeleteFailed,
	DraftsDisabled,
	ReactionsDisabled,
	BodyRequired,
	UsernameInvalidFormat,
	UsernameTooShort,
	UsernameTooLong,
	DisplayNameEmpty,
	Denied,
	Unauthorized,
] as const satisfies ReadonlyArray<new (props: {message: string}) => unknown>;

/**
 * Codes the package emits independent of any declaration — defects /
 * un-annotated failures (`INTERNAL_WIRE_CODE`) and Schema rejections
 * (`InputValidationError`'s `VALIDATION_ERROR`). They have no domain class to
 * pin, so the staleness guard exempts them from oracle coverage.
 */
const PACKAGE_INTRINSIC_CODES: ReadonlySet<string> = new Set([
	INTERNAL_WIRE_CODE,
	"VALIDATION_ERROR",
]);

describe("fate wire-code annotations", () => {
	it.each(ORACLE_ENTRIES)("%o carries its specific wire code", (ctor, code) => {
		expect(wireCodeOfClass(ctor as never)).toBe(code);
	});

	it.each(ROUND_TRIP_CLASSES)("%o encodes to its wire code with its own message", (ctor) => {
		const code = EXPECTED_CODE.get(ctor);
		const wire = encodeWireError(new ctor({message: `${code} message`}));
		expect(wire.code).toBe(code);
		expect(wire.message).toBe(`${code} message`);
	});

	it("the oracle pins every annotated code fateConfig can emit (can't go stale)", () => {
		const pinned = new Set<string>(EXPECTED_CODE.values());
		const unpinned = [...declaredWireCodes(fateConfig)].filter(
			(code) => !pinned.has(code) && !PACKAGE_INTRINSIC_CODES.has(code),
		);
		expect(unpinned).toEqual([]);
	});
});
