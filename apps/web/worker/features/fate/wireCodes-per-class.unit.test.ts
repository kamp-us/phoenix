/**
 * Per-class wire-code pin (T0), consolidated.
 *
 * Every annotated domain error class reachable from `fateConfig` is enumerated
 * here and pinned to a *declared* wire code, so the annotation-derived codec
 * (`.patterns/fate-effect-wire-errors.md`) and the SPA's `FATE_WIRE_CODES`
 * vocabulary can't drift through the migration — and an annotated instance
 * round-trips through `encodeWireError` to that code with its own message.
 *
 * The expected code is read from each class's `FateWireCode` annotation
 * (`wireCodeOfClass`) — the single author site — never from a hand-maintained
 * parallel literal, so a rename can't pass by being applied to two copies.
 *
 * This is the exact code-per-class binding the aggregate guards do NOT assert:
 * `wireCodes.unit.test.ts` proves the SPA list covers `declaredWireCodes`, and
 * `packages/fate-effect/src/Server.unit.test.ts` owns the AST-walk that derives
 * those codes — neither pins WHICH class carries a declared code. The staleness
 * guard at the bottom binds this enumeration to `fateConfig` so a feature added
 * with an unenumerated annotated code fails CI here instead of silently escaping
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
 * Every annotated domain error class `fateConfig` can emit. The wire code for
 * each is read from its `FateWireCode` annotation below — this list authors only
 * *which* classes exist, not their codes. The staleness guard proves this set
 * covers every code in `declaredWireCodes(fateConfig)` (modulo the
 * package-intrinsic codes), so a newly-declared annotated error can't escape
 * this per-class coverage.
 */
const ANNOTATED_CLASSES = [
	// pano
	TitleRequired,
	TitleTooLong,
	UrlInvalid,
	PostBodyTooLong,
	TagsRequired,
	TagInvalid,
	CommentBodyRequired,
	CommentBodyTooLong,
	ParentCommentNotFound,
	PostNotFound,
	CommentNotFound,
	UnauthorizedPostMutation,
	UnauthorizedCommentMutation,
	DraftsDisabled,
	// sozluk
	BodyRequired,
	BodyTooLong,
	DefinitionNotFound,
	UnauthorizedDefinitionMutation,
	// pasaport
	UsernameInvalidFormat,
	UsernameTooShort,
	UsernameTooLong,
	UsernameTaken,
	UsernameAlreadySet,
	UserNotFound,
	// report + the package-side gate the SPA already decodes for writes
	NotAModerator,
	Unauthorized,
] as const satisfies ReadonlyArray<unknown>;

/**
 * The subset whose only required field is `message`, so an instance can be
 * constructed generically here for the `encodeWireError` round-trip. The codec
 * reads the same annotation regardless of payload, so one message-only
 * representative per distinct code proves the mechanism; classes with extra
 * required fields (`postId`, `definitionId`, …) are still pinned for their code
 * by the full enumeration above. Typed as a constructor over `{message}` so the
 * generic `new ctor` below type-checks against a homogeneous shape.
 */
const ROUND_TRIP_CASES = [
	TitleRequired,
	TitleTooLong,
	UrlInvalid,
	PostBodyTooLong,
	TagsRequired,
	TagInvalid,
	CommentBodyRequired,
	CommentBodyTooLong,
	ParentCommentNotFound,
	DraftsDisabled,
	BodyRequired,
	UsernameInvalidFormat,
	UsernameTooShort,
	UsernameTooLong,
	NotAModerator,
	Unauthorized,
] as const satisfies ReadonlyArray<new (props: {message: string}) => unknown>;

/**
 * Codes the package emits independent of any declaration — defects /
 * un-annotated failures (`INTERNAL_WIRE_CODE`) and Schema rejections
 * (`InputValidationError`'s `VALIDATION_ERROR`). They have no domain class to
 * pin, so the staleness guard exempts them from enumeration coverage.
 */
const PACKAGE_INTRINSIC_CODES: ReadonlySet<string> = new Set([
	INTERNAL_WIRE_CODE,
	"VALIDATION_ERROR",
]);

describe("fate wire-code annotations", () => {
	it.each(ANNOTATED_CLASSES)("%o carries a declared wire code", (ctor) => {
		const code = wireCodeOfClass(ctor);
		expect(code).toBeDefined();
		expect(declaredWireCodes(fateConfig)).toContain(code);
	});

	it.each(ROUND_TRIP_CASES)("%o encodes to its wire code with its own message", (ctor) => {
		const code = wireCodeOfClass(ctor);
		const wire = encodeWireError(new ctor({message: `${code} message`}));
		expect(wire.code).toBe(code);
		expect(wire.message).toBe(`${code} message`);
	});

	it("the enumeration covers every annotated code fateConfig can emit (can't go stale)", () => {
		const covered = new Set<string>();
		for (const ctor of ANNOTATED_CLASSES) {
			const code = wireCodeOfClass(ctor);
			if (code !== undefined) covered.add(code);
		}
		const uncovered = [...declaredWireCodes(fateConfig)].filter(
			(code) => !covered.has(code) && !PACKAGE_INTRINSIC_CODES.has(code),
		);
		expect(uncovered).toEqual([]);
	});
});
