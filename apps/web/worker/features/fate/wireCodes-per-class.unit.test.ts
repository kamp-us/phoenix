/**
 * Per-class wire-code pin — which class carries WHICH code, the binding the aggregate
 * guards do not assert. See `.patterns/fate-effect-wire-errors.md`.
 *
 * `EXPECTED_CODE` must stay a hand-authored literal, never read back from
 * `wireCodeOfClass`: codes are legitimately shared across classes (`UNAUTHORIZED` ×4,
 * `BODY_TOO_LONG` ×3), so a set-membership check still passes when a class is
 * mis-annotated to another valid code. The annotation is the sole class→code author
 * site, so asserting it against itself is a tautology.
 *
 * The staleness guard at the bottom binds the oracle to `fateConfig`, so a feature
 * added with an unpinned annotated code fails CI here instead of silently escaping
 * per-class coverage.
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
import {MecmuaDisabled, MecmuaPostNotFound, MecmuaTitleRequired} from "../mecmua/errors.ts";
import {MuteDisabled, SelfMuteRejected} from "../mute/errors.ts";
import {
	CommentBodyRequired,
	CommentBodyTooLong,
	CommentNotFound,
	ParentCommentNotFound,
	PostBodyTooLong,
	PostDeleteFailed,
	PostNotFound,
	TagInvalid,
	TagsRequired,
	TitleRequired,
	TitleTooLong,
	UnauthorizedCommentMutation,
	UnauthorizedPostMutation,
	UrlInvalid,
} from "../pano/errors.ts";
import {
	BanReasonRequired,
	DisplayNameEmpty,
	EmailFailingReasonRequired,
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

const EXPECTED_CODE = new Map<new (...args: never[]) => unknown, string>([
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
	[MecmuaDisabled, "MECMUA_DISABLED"],
	[MecmuaPostNotFound, "MECMUA_POST_NOT_FOUND"],
	[MecmuaTitleRequired, "TITLE_REQUIRED"],
	[MuteDisabled, "MUTE_DISABLED"],
	[SelfMuteRejected, "SELF_MUTE_REJECTED"],
	[BodyRequired, "BODY_REQUIRED"],
	[BodyTooLong, "BODY_TOO_LONG"],
	[DefinitionNotFound, "DEFINITION_NOT_FOUND"],
	[UnauthorizedDefinitionMutation, "UNAUTHORIZED"],
	[UsernameInvalidFormat, "INVALID_FORMAT"],
	[UsernameTooShort, "TOO_SHORT"],
	[UsernameTooLong, "TOO_LONG"],
	[UsernameTaken, "TAKEN"],
	[UsernameAlreadySet, "ALREADY_SET"],
	[UserNotFound, "USER_NOT_FOUND"],
	[DisplayNameEmpty, "DISPLAY_NAME_EMPTY"],
	[BanReasonRequired, "BAN_REASON_REQUIRED"],
	[EmailFailingReasonRequired, "EMAIL_FAILING_REASON_REQUIRED"],
	[Denied, "UNAUTHORIZED"],
	[Unauthorized, "UNAUTHORIZED"],
	// The five below carry extra required fields, so they are pinned here but cannot be
	// generically instantiated in ROUND_TRIP_CLASSES.
	[RequiresLevel, "FORBIDDEN"],
	[VouchLimitReached, "VOUCH_LIMIT_REACHED"],
	[VoterNotEligible, "VOTE_REQUIRES_YAZAR"],
	[SelfVoteNotAllowed, "SELF_VOTE_NOT_ALLOWED"],
	[InsufficientKarma, "INSUFFICIENT_KARMA"],
]);

const ORACLE_ENTRIES = [...EXPECTED_CODE.entries()] as ReadonlyArray<[unknown, string]>;

/**
 * The oracle classes whose only required field is `message`, so an instance can be
 * constructed generically for the `encodeWireError` round-trip. This list authors only
 * WHICH classes to instantiate — codes are looked up in the oracle, never re-listed.
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
	MecmuaDisabled,
	MecmuaPostNotFound,
	BodyRequired,
	UsernameInvalidFormat,
	UsernameTooShort,
	UsernameTooLong,
	DisplayNameEmpty,
	BanReasonRequired,
	EmailFailingReasonRequired,
	Denied,
	Unauthorized,
] as const satisfies ReadonlyArray<new (props: {message: string}) => unknown>;

/** Codes the package emits with no domain class to pin, so the staleness guard exempts them. */
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
