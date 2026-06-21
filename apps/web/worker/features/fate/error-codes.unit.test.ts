/**
 * Per-class wire-code pin (T0), consolidated.
 *
 * Every annotated domain error class reachable from `fateConfig` is pinned to
 * the exact wire `code` the retired bridge registry emitted for it, so the
 * annotation-derived codec (`.patterns/fate-effect-wire-errors.md`) and the
 * SPA's `FATE_WIRE_CODES` vocabulary can't drift through the migration — and
 * an annotated instance round-trips through `encodeWireError` to that code
 * with its own message.
 *
 * This is the exact code-per-class binding the aggregate guards do NOT assert:
 * `wireCodes.unit.test.ts` proves the SPA list covers `declaredWireCodes`, and
 * `packages/fate-effect/src/Server.unit.test.ts` owns the AST-walk that derives
 * those codes — neither pins WHICH class carries WHICH code.
 *
 * The single table here replaces the per-feature `errors.unit.test.ts` files
 * (one `[Class→code]` table each); the staleness guard at the bottom binds the
 * table to `fateConfig` so a feature added with an unpinned annotated code
 * fails CI here instead of silently escaping per-class coverage.
 */

import {
	declaredWireCodes,
	encodeWireError,
	INTERNAL_WIRE_CODE,
	Unauthorized,
	wireCodeOfClass,
} from "@kampus/fate-effect";
import {describe, expect, it} from "vitest";
import {
	CommentBodyRequired,
	CommentBodyTooLong,
	CommentNotFound,
	DraftsDisabled,
	ParentCommentNotFound,
	PostBodyTooLong,
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
	UserNotFound,
	UsernameAlreadySet,
	UsernameInvalidFormat,
	UsernameTaken,
	UsernameTooLong,
	UsernameTooShort,
} from "../pasaport/errors.ts";
import {NotAModerator} from "../report/Moderator.ts";
import {
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
} from "../sozluk/errors.ts";
import {fateConfig} from "./config.ts";

/**
 * Every annotated domain error class `fateConfig` can emit, pinned to its wire
 * code. The staleness guard below proves this list covers every code in
 * `declaredWireCodes(fateConfig)` (modulo the package-intrinsic codes), so a
 * newly-declared annotated error can't escape this per-class coverage.
 */
const WIRE_CODES = [
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
	[CommentNotFound, "COMMENT_NOT_FOUND"],
	[UnauthorizedPostMutation, "UNAUTHORIZED"],
	[UnauthorizedCommentMutation, "UNAUTHORIZED"],
	[DraftsDisabled, "DRAFTS_DISABLED"],
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
	// report + the package-side gate the SPA already decodes for writes
	[NotAModerator, "UNAUTHORIZED"],
	[Unauthorized, "UNAUTHORIZED"],
] as const satisfies ReadonlyArray<readonly [unknown, string]>;

/**
 * The subset whose only required field is `message`, so an instance can be
 * constructed generically here for the `encodeWireError` round-trip. The codec
 * reads the same annotation regardless of payload, so one message-only
 * representative per distinct code proves the mechanism; classes with extra
 * required fields (`postId`, `definitionId`, …) are still pinned for their code
 * by the full table above. Typed as a constructor over `{message}` so the
 * generic `new ctor` below type-checks against a homogeneous shape.
 */
const ROUND_TRIP_CASES = [
	[TitleRequired, "TITLE_REQUIRED"],
	[TitleTooLong, "TITLE_TOO_LONG"],
	[UrlInvalid, "URL_INVALID"],
	[PostBodyTooLong, "BODY_TOO_LONG"],
	[TagsRequired, "TAGS_REQUIRED"],
	[TagInvalid, "TAG_INVALID"],
	[CommentBodyRequired, "BODY_REQUIRED"],
	[CommentBodyTooLong, "BODY_TOO_LONG"],
	[ParentCommentNotFound, "PARENT_NOT_FOUND"],
	[DraftsDisabled, "DRAFTS_DISABLED"],
	[BodyRequired, "BODY_REQUIRED"],
	[UsernameInvalidFormat, "INVALID_FORMAT"],
	[UsernameTooShort, "TOO_SHORT"],
	[UsernameTooLong, "TOO_LONG"],
	[NotAModerator, "UNAUTHORIZED"],
	[Unauthorized, "UNAUTHORIZED"],
] as const satisfies ReadonlyArray<readonly [new (props: {message: string}) => unknown, string]>;

/**
 * Codes the package emits independent of any declaration — defects /
 * un-annotated failures (`INTERNAL_WIRE_CODE`) and Schema rejections
 * (`InputValidationError`'s `VALIDATION_ERROR`). They have no domain class to
 * pin, so the staleness guard exempts them from table coverage.
 */
const PACKAGE_INTRINSIC_CODES: ReadonlySet<string> = new Set([
	INTERNAL_WIRE_CODE,
	"VALIDATION_ERROR",
]);

describe("fate wire-code annotations", () => {
	it.each(WIRE_CODES)("%o carries its bridge wire code", (ctor, code) => {
		expect(wireCodeOfClass(ctor)).toBe(code);
	});

	it.each(ROUND_TRIP_CASES)("%o encodes to its wire code with its own message", (ctor, code) => {
		const wire = encodeWireError(new ctor({message: `${code} message`}));
		expect(wire.code).toBe(code);
		expect(wire.message).toBe(`${code} message`);
	});

	it("the table pins every annotated code fateConfig can emit (can't go stale)", () => {
		const pinned = new Set<string>(WIRE_CODES.map(([, code]) => code));
		const unpinned = [...declaredWireCodes(fateConfig)].filter(
			(code) => !pinned.has(code) && !PACKAGE_INTRINSIC_CODES.has(code),
		);
		expect(unpinned).toEqual([]);
	});
});
