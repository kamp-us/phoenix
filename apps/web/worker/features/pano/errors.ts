/**
 * Tagged errors raised by the Pano service layer. Each carries its wire `code`
 * as an `ErrorCode` annotation that `encodeWireError` reads at the fate boundary
 * (`.patterns/fate-effect-wire-errors.md`).
 *
 * The retired bridge's `PostValidation` / `CommentValidation` carried a dynamic
 * `code` field the registry upcased per instance; `ErrorCode` is one static code
 * per class, so each former sub-code is now its own class. {@link PostValidation}
 * / {@link CommentValidation} survive as the union aliases the `Pano` signatures
 * name. Wire codes are preserved verbatim from the bridge so SPA pattern-matching
 * keeps working; `errors.unit.test.ts` pins each pair.
 */
import {ErrorCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

export class TitleRequired extends Schema.TaggedErrorClass<TitleRequired>()(
	"pano/TitleRequired",
	{message: Schema.String},
	{[ErrorCode]: "TITLE_REQUIRED"},
) {}

export class TitleTooLong extends Schema.TaggedErrorClass<TitleTooLong>()(
	"pano/TitleTooLong",
	{message: Schema.String},
	{[ErrorCode]: "TITLE_TOO_LONG"},
) {}

export class UrlInvalid extends Schema.TaggedErrorClass<UrlInvalid>()(
	"pano/UrlInvalid",
	{message: Schema.String},
	{[ErrorCode]: "URL_INVALID"},
) {}

export class PostBodyTooLong extends Schema.TaggedErrorClass<PostBodyTooLong>()(
	"pano/PostBodyTooLong",
	{message: Schema.String},
	{[ErrorCode]: "BODY_TOO_LONG"},
) {}

export class TagsRequired extends Schema.TaggedErrorClass<TagsRequired>()(
	"pano/TagsRequired",
	{message: Schema.String},
	{[ErrorCode]: "TAGS_REQUIRED"},
) {}

export class TagInvalid extends Schema.TaggedErrorClass<TagInvalid>()(
	"pano/TagInvalid",
	{message: Schema.String},
	{[ErrorCode]: "TAG_INVALID"},
) {}

// Spread into mutation `error:` unions; {@link PostValidation} is derived from
// this tuple, so the two can't drift.
export const PostValidationErrors = [
	TitleRequired,
	TitleTooLong,
	UrlInvalid,
	PostBodyTooLong,
	TagsRequired,
	TagInvalid,
] as const;

export type PostValidation = InstanceType<(typeof PostValidationErrors)[number]>;

export class CommentBodyRequired extends Schema.TaggedErrorClass<CommentBodyRequired>()(
	"pano/CommentBodyRequired",
	{message: Schema.String},
	{[ErrorCode]: "BODY_REQUIRED"},
) {}

export class CommentBodyTooLong extends Schema.TaggedErrorClass<CommentBodyTooLong>()(
	"pano/CommentBodyTooLong",
	{message: Schema.String},
	{[ErrorCode]: "BODY_TOO_LONG"},
) {}

export class ParentCommentNotFound extends Schema.TaggedErrorClass<ParentCommentNotFound>()(
	"pano/ParentCommentNotFound",
	{message: Schema.String},
	{[ErrorCode]: "PARENT_NOT_FOUND"},
) {}

export const CommentValidationErrors = [
	CommentBodyRequired,
	CommentBodyTooLong,
	ParentCommentNotFound,
] as const;

export type CommentValidation = InstanceType<(typeof CommentValidationErrors)[number]>;

export class PostNotFound extends Schema.TaggedErrorClass<PostNotFound>()(
	"pano/PostNotFound",
	{
		postId: Schema.String,
		message: Schema.String,
	},
	{[ErrorCode]: "POST_NOT_FOUND"},
) {}

export class CommentNotFound extends Schema.TaggedErrorClass<CommentNotFound>()(
	"pano/CommentNotFound",
	{
		commentId: Schema.String,
		message: Schema.String,
	},
	{[ErrorCode]: "COMMENT_NOT_FOUND"},
) {}

export class UnauthorizedPostMutation extends Schema.TaggedErrorClass<UnauthorizedPostMutation>()(
	"pano/UnauthorizedPostMutation",
	{
		postId: Schema.String,
		message: Schema.String,
	},
	{[ErrorCode]: "UNAUTHORIZED"},
) {}

export class UnauthorizedCommentMutation extends Schema.TaggedErrorClass<UnauthorizedCommentMutation>()(
	"pano/UnauthorizedCommentMutation",
	{
		commentId: Schema.String,
		message: Schema.String,
	},
	{[ErrorCode]: "UNAUTHORIZED"},
) {}

/**
 * Drafts (taslak) are reachable only when the `pano-draft-save` flag is on. The
 * server-side gate raises this when a draft mutation runs with the flag off, so the
 * dark path is unreachable even if a client bypasses the UI. See issue #746.
 */
export class DraftsDisabled extends Schema.TaggedErrorClass<DraftsDisabled>()(
	"pano/DraftsDisabled",
	{message: Schema.String},
	{[ErrorCode]: "DRAFTS_DISABLED"},
) {}
