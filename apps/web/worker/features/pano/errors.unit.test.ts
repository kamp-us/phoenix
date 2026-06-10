/**
 * Pano error-class ↔ wire-code enumeration pin (T0).
 *
 * The migrated pano records derive wire codes from the `fateWireCode`
 * annotation on each error class (`.patterns/fate-effect-wire-errors.md`) —
 * no registry. This pin is the app-side counterpart of the package's
 * `WireError.unit.test.ts` enumeration: every error class pano operations
 * can fail with, paired with the exact wire code the bridge's
 * `WIRE_CODE_BY_TAG` registry emitted for it, so the annotation-derived codec
 * and the SPA's `MUTATION_ERROR_CODES` vocabulary cannot drift through the
 * migration.
 *
 * The bridge's `pano/PostValidation` / `pano/CommentValidation` carried a
 * dynamic `code` field the registry upcased per instance (`title_required` →
 * `TITLE_REQUIRED`); `fateWireCode` is ONE static code per class
 * (`wireCodeOf` reads the instance's CONSTRUCTOR annotation), so each
 * sub-code is now its own class — this table pins every split class to the
 * exact upcased code the `upcased` registry arm produced for it.
 */
import {encodeWireError, wireCodeOfClass} from "@phoenix/fate-effect";
import {describe, expect, it} from "vitest";
import {
	CommentBodyRequired,
	CommentBodyTooLong,
	CommentNotFound,
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
} from "./errors.ts";

/**
 * The pinned pairs — wire codes preserved verbatim from the bridge registry
 * (`worker/features/fate/errors.ts` `WIRE_CODE_BY_TAG`, pano section: the
 * `fixed` arms plus every member of the two `upcased` arms' declared sets).
 */
const PANO_WIRE_CODES = [
	// PostValidation sub-codes (the bridge's `upcased` arm, one class each).
	[TitleRequired, "TITLE_REQUIRED"],
	[TitleTooLong, "TITLE_TOO_LONG"],
	[UrlInvalid, "URL_INVALID"],
	[PostBodyTooLong, "BODY_TOO_LONG"],
	[TagsRequired, "TAGS_REQUIRED"],
	[TagInvalid, "TAG_INVALID"],
	// CommentValidation sub-codes.
	[CommentBodyRequired, "BODY_REQUIRED"],
	[CommentBodyTooLong, "BODY_TOO_LONG"],
	[ParentCommentNotFound, "PARENT_NOT_FOUND"],
	// Fixed arms.
	[PostNotFound, "POST_NOT_FOUND"],
	[CommentNotFound, "COMMENT_NOT_FOUND"],
	[UnauthorizedPostMutation, "UNAUTHORIZED"],
	[UnauthorizedCommentMutation, "UNAUTHORIZED"],
] as const;

describe("pano wire-code annotations", () => {
	it.each(PANO_WIRE_CODES)("%o carries its bridge wire code", (ctor, code) => {
		expect(wireCodeOfClass(ctor)).toBe(code);
	});

	it("an annotated instance encodes to its wire code with its own message", () => {
		const error = new TagsRequired({message: "en az bir etiket seç"});
		const wire = encodeWireError(error);
		expect(wire.code).toBe("TAGS_REQUIRED");
		expect(wire.message).toBe("en az bir etiket seç");
	});
});
