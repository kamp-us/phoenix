/**
 * Pins every pano error class to the exact wire code the retired bridge's
 * registry emitted for it, so the annotation-derived codec and the SPA's
 * `MUTATION_ERROR_CODES` vocabulary can't drift through the migration. See
 * `errors.ts` for why each former validation sub-code is now its own class.
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

const PANO_WIRE_CODES = [
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
