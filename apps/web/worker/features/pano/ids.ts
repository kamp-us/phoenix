/**
 * Pano's feature-local branded id schemas (epic #2700). `PostId` / `CommentId`
 * are nominal string tags minted from the shared `brandedId` factory, so a
 * `postId`/`commentId` transposition at a write call site is a compile error
 * while wire and D1 bytes stay identical (the brand is type-only — see
 * `../../lib/ids.ts`). They live here, beside the pano feature, because only
 * pano references them; the cross-feature `UserId` is imported read-only from
 * the shared module. Idiom + tracer precedent: `features/sozluk` (#2712).
 */
import {brandedId} from "../../lib/ids.ts";

export const PostId = brandedId("PostId");
export type PostId = typeof PostId.Type;

export const CommentId = brandedId("CommentId");
export type CommentId = typeof CommentId.Type;
