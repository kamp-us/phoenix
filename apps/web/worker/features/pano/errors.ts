/**
 * Tagged errors raised by the Pano service layer.
 *
 * Wire-code contract — every class carries its wire `code` as a
 * `fateWireCode` annotation (`.patterns/fate-effect-wire-errors.md`), which
 * `encodeWireError` reads at the fate boundary:
 *
 *   pano/TitleRequired                  → TITLE_REQUIRED
 *   pano/TitleTooLong                   → TITLE_TOO_LONG
 *   pano/UrlInvalid                     → URL_INVALID
 *   pano/PostBodyTooLong                → BODY_TOO_LONG
 *   pano/TagsRequired                   → TAGS_REQUIRED
 *   pano/TagInvalid                     → TAG_INVALID
 *   pano/CommentBodyRequired            → BODY_REQUIRED
 *   pano/CommentBodyTooLong             → BODY_TOO_LONG
 *   pano/ParentCommentNotFound          → PARENT_NOT_FOUND
 *   pano/PostNotFound                   → POST_NOT_FOUND
 *   pano/CommentNotFound                → COMMENT_NOT_FOUND
 *   pano/UnauthorizedPostMutation       → UNAUTHORIZED
 *   pano/UnauthorizedCommentMutation    → UNAUTHORIZED
 *
 * The bridge-era `PostValidation` / `CommentValidation` classes carried a
 * dynamic `code` field the registry upcased per instance (`title_required` →
 * `TITLE_REQUIRED`). `fateWireCode` is one static code per class — the codec
 * reads the instance's CONSTRUCTOR annotation (`wireCodeOf`), so each
 * sub-code is its own class and {@link PostValidation} /
 * {@link CommentValidation} survive as the union aliases the `Pano` service
 * signatures name. Wire codes preserved verbatim (they match the bridge's
 * retired `upcased`/`fixed` registry arms exactly) so SPA pattern-matching
 * keeps working unchanged; `errors.unit.test.ts` pins each pair.
 */
import {fateWireCode} from "@phoenix/fate-effect";
import * as Schema from "effect/Schema";

/* -------------------------------------------------------------------------- */
/* Post validation (one class per bridge sub-code)                             */
/* -------------------------------------------------------------------------- */

/** `title` of `submitPost` / `editPost` was empty after trimming. */
export class TitleRequired extends Schema.TaggedErrorClass<TitleRequired>()(
	"pano/TitleRequired",
	{message: Schema.String},
	{[fateWireCode]: "TITLE_REQUIRED"},
) {}

/** `title` exceeded the configured maximum (`POST_TITLE_MAX`). */
export class TitleTooLong extends Schema.TaggedErrorClass<TitleTooLong>()(
	"pano/TitleTooLong",
	{message: Schema.String},
	{[fateWireCode]: "TITLE_TOO_LONG"},
) {}

/** `url` of `submitPost` did not parse as a URL. */
export class UrlInvalid extends Schema.TaggedErrorClass<UrlInvalid>()(
	"pano/UrlInvalid",
	{message: Schema.String},
	{[fateWireCode]: "URL_INVALID"},
) {}

/** Post `body` exceeded the configured maximum (`POST_BODY_MAX`). */
export class PostBodyTooLong extends Schema.TaggedErrorClass<PostBodyTooLong>()(
	"pano/PostBodyTooLong",
	{message: Schema.String},
	{[fateWireCode]: "BODY_TOO_LONG"},
) {}

/** `submitPost` received an empty tag list. */
export class TagsRequired extends Schema.TaggedErrorClass<TagsRequired>()(
	"pano/TagsRequired",
	{message: Schema.String},
	{[fateWireCode]: "TAGS_REQUIRED"},
) {}

/** A submitted tag `kind` is outside the fixed enum (`ALLOWED_POST_TAG_KINDS`). */
export class TagInvalid extends Schema.TaggedErrorClass<TagInvalid>()(
	"pano/TagInvalid",
	{message: Schema.String},
	{[fateWireCode]: "TAG_INVALID"},
) {}

/**
 * `submitPost` / `editPost` rejected its input — the union the `Pano` service
 * signatures declare. Replaces the bridge-era single `PostValidation` class
 * (whose `code` field named the sub-code; see the module header).
 */
export type PostValidation =
	| TitleRequired
	| TitleTooLong
	| UrlInvalid
	| PostBodyTooLong
	| TagsRequired
	| TagInvalid;

/**
 * The `PostValidation` members as schema classes, in bridge-registry order —
 * spread into mutation `error:` unions so the declared set cannot drift from
 * the alias above.
 */
export const PostValidationErrors = [
	TitleRequired,
	TitleTooLong,
	UrlInvalid,
	PostBodyTooLong,
	TagsRequired,
	TagInvalid,
] as const;

/* -------------------------------------------------------------------------- */
/* Comment validation (one class per bridge sub-code)                          */
/* -------------------------------------------------------------------------- */

/** Comment `body` of `addComment` / `editComment` was empty after trimming. */
export class CommentBodyRequired extends Schema.TaggedErrorClass<CommentBodyRequired>()(
	"pano/CommentBodyRequired",
	{message: Schema.String},
	{[fateWireCode]: "BODY_REQUIRED"},
) {}

/** Comment `body` exceeded the configured maximum (`COMMENT_BODY_MAX`). */
export class CommentBodyTooLong extends Schema.TaggedErrorClass<CommentBodyTooLong>()(
	"pano/CommentBodyTooLong",
	{message: Schema.String},
	{[fateWireCode]: "BODY_TOO_LONG"},
) {}

/** `addComment`'s `parentId` names no live comment on the target post. */
export class ParentCommentNotFound extends Schema.TaggedErrorClass<ParentCommentNotFound>()(
	"pano/ParentCommentNotFound",
	{message: Schema.String},
	{[fateWireCode]: "PARENT_NOT_FOUND"},
) {}

/**
 * `addComment` / `editComment` rejected its input — the union the `Pano`
 * service signatures declare (see {@link PostValidation}).
 */
export type CommentValidation = CommentBodyRequired | CommentBodyTooLong | ParentCommentNotFound;

/** The `CommentValidation` members as schema classes (see {@link PostValidationErrors}). */
export const CommentValidationErrors = [
	CommentBodyRequired,
	CommentBodyTooLong,
	ParentCommentNotFound,
] as const;

/* -------------------------------------------------------------------------- */
/* Not-found / authorization                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Raised by every post mutation that targets a missing post (no
 * `post_summary` row, or the row has been soft-deleted in cases where
 * existence is required).
 */
export class PostNotFound extends Schema.TaggedErrorClass<PostNotFound>()(
	"pano/PostNotFound",
	{
		postId: Schema.String,
		message: Schema.String,
	},
	{[fateWireCode]: "POST_NOT_FOUND"},
) {}

/**
 * Raised by every comment mutation that targets a missing or already-removed
 * comment.
 */
export class CommentNotFound extends Schema.TaggedErrorClass<CommentNotFound>()(
	"pano/CommentNotFound",
	{
		commentId: Schema.String,
		message: Schema.String,
	},
	{[fateWireCode]: "COMMENT_NOT_FOUND"},
) {}

/**
 * Raised by `editPost` / `deletePost` when the calling user is not the row's
 * author.
 */
export class UnauthorizedPostMutation extends Schema.TaggedErrorClass<UnauthorizedPostMutation>()(
	"pano/UnauthorizedPostMutation",
	{
		postId: Schema.String,
		message: Schema.String,
	},
	{[fateWireCode]: "UNAUTHORIZED"},
) {}

/**
 * Raised by `editComment` / `deleteComment` when the calling user is not the
 * comment's author.
 */
export class UnauthorizedCommentMutation extends Schema.TaggedErrorClass<UnauthorizedCommentMutation>()(
	"pano/UnauthorizedCommentMutation",
	{
		commentId: Schema.String,
		message: Schema.String,
	},
	{[fateWireCode]: "UNAUTHORIZED"},
) {}
