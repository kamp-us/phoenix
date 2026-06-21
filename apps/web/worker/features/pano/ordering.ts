/**
 * Pano connection orderings the view `orderBy` and the service keyset share
 * (ADR 0019; see `db/ordering.ts`). The post-feed sort lives in
 * `src/lib/panoFeedSort.ts` (per-sort, DB-free so the SPA shares it); this is
 * the comment-thread ordering, which has no SPA half.
 */

import * as schema from "../../db/drizzle/schema.ts";
import type {Ordering} from "../../db/ordering.ts";

/**
 * `Post.comments` (the comment thread): `createdAt asc, id asc`. Consumed by
 * `Post.comments`' view `orderBy` and the `Pano.listCommentsKeyset` keyset.
 */
export const COMMENT_ORDERING: Ordering = [
	{field: "createdAt", column: schema.commentRecord.createdAt, dir: "asc"},
	{field: "id", column: schema.commentRecord.id, dir: "asc"},
];
