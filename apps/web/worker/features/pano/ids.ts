/**
 * Pano's feature-local branded id schemas: `PostId` / `CommentId` from the shared `brandedId`
 * factory, so a transposition at a write call site is a compile error while wire and D1 bytes
 * stay identical. They live here because only pano references them; the cross-feature
 * `UserId` is imported from `../../lib/ids.ts`.
 */
import {brandedId} from "../../lib/ids.ts";

export const PostId = brandedId("PostId");
export type PostId = typeof PostId.Type;

export const CommentId = brandedId("CommentId");
export type CommentId = typeof CommentId.Type;
