/**
 * Tagged errors raised by the Pano service layer.
 *
 * Wire-code contract — every tag in this file maps to a specific
 * `code` string via `worker/features/fate/errors.ts::encodeFateError`:
 *
 *   pano/PostNotFound                   → POST_NOT_FOUND
 *   pano/CommentNotFound                → COMMENT_NOT_FOUND
 *   pano/UnauthorizedPostMutation       → UNAUTHORIZED
 *   pano/UnauthorizedCommentMutation    → UNAUTHORIZED
 *   pano/PostValidation                 → <code uppercased>  (title_required,
 *                                                              title_too_long,
 *                                                              url_invalid,
 *                                                              body_too_long,
 *                                                              tags_required,
 *                                                              tag_invalid)
 *   pano/CommentValidation              → <code uppercased>  (body_required,
 *                                                              body_too_long,
 *                                                              parent_not_found)
 *
 * Mirrors the legacy `PostValidationError` / `PostNotFoundError` /
 * `UnauthorizedPostMutationError` / `CommentValidationError` /
 * `CommentNotFoundError` / `UnauthorizedCommentMutationError` shapes that lived
 * in `pano/module.ts` pre-effect-migration. Wire codes preserved verbatim so
 * SPA pattern-matching keeps working unchanged.
 */
import * as Schema from "effect/Schema";

/**
 * Codes carried by `PostValidation`. Mirrors the legacy
 * `PostValidationError.code` union. Each value upcased becomes the wire-format
 * `extensions.code` (`TITLE_REQUIRED`, etc.).
 *
 * Lives in `errors.ts` (the leaf of the import graph) per the feature-service
 * layout rule — `Pano.ts → errors.ts` is the only allowed direction.
 */
export type PostValidationCode =
	| "title_required"
	| "title_too_long"
	| "url_invalid"
	| "body_too_long"
	| "tags_required"
	| "tag_invalid";

/** Schema-form of {@link PostValidationCode}, used as the `code` field type. */
const PostValidationCodeSchema = Schema.Literals([
	"title_required",
	"title_too_long",
	"url_invalid",
	"body_too_long",
	"tags_required",
	"tag_invalid",
]);

/**
 * Codes carried by `CommentValidation`. Mirrors the legacy
 * `CommentValidationError.code` union.
 */
export type CommentValidationCode = "body_required" | "body_too_long" | "parent_not_found";

/** Schema-form of {@link CommentValidationCode}, used as the `code` field type. */
const CommentValidationCodeSchema = Schema.Literals([
	"body_required",
	"body_too_long",
	"parent_not_found",
]);

/**
 * `submitPost` / `editPost` rejected its input. Carries a `code` (so the
 * codec can upcase it to the wire string) and a Turkish `message` for the
 * SPA to render.
 */
export class PostValidation extends Schema.TaggedErrorClass<PostValidation>()(
	"pano/PostValidation",
	{
		code: PostValidationCodeSchema,
		message: Schema.String,
	},
) {}

/**
 * `addComment` / `editComment` rejected its input. Carries a `code` and a
 * Turkish `message`.
 */
export class CommentValidation extends Schema.TaggedErrorClass<CommentValidation>()(
	"pano/CommentValidation",
	{
		code: CommentValidationCodeSchema,
		message: Schema.String,
	},
) {}

/**
 * Raised by every post mutation that targets a missing post (no
 * `post_summary` row, or the row has been soft-deleted in cases where
 * existence is required). Maps to `POST_NOT_FOUND`.
 */
export class PostNotFound extends Schema.TaggedErrorClass<PostNotFound>()("pano/PostNotFound", {
	postId: Schema.String,
	message: Schema.String,
}) {}

/**
 * Raised by every comment mutation that targets a missing or already-removed
 * comment. Maps to `COMMENT_NOT_FOUND`.
 */
export class CommentNotFound extends Schema.TaggedErrorClass<CommentNotFound>()(
	"pano/CommentNotFound",
	{
		commentId: Schema.String,
		message: Schema.String,
	},
) {}

/**
 * Raised by `editPost` / `deletePost` when the calling user is not the row's
 * author. Maps to `UNAUTHORIZED`.
 */
export class UnauthorizedPostMutation extends Schema.TaggedErrorClass<UnauthorizedPostMutation>()(
	"pano/UnauthorizedPostMutation",
	{
		postId: Schema.String,
		message: Schema.String,
	},
) {}

/**
 * Raised by `editComment` / `deleteComment` when the calling user is not the
 * comment's author. Maps to `UNAUTHORIZED`.
 */
export class UnauthorizedCommentMutation extends Schema.TaggedErrorClass<UnauthorizedCommentMutation>()(
	"pano/UnauthorizedCommentMutation",
	{
		commentId: Schema.String,
		message: Schema.String,
	},
) {}
