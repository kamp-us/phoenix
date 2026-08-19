/**
 * mecmua connection orderings the view `orderBy` and the service keyset share (ADR
 * 0019). Unlike pano, the subscribed-author feed is a TIME feed: it orders on
 * `published_at`, not a hot score.
 */

import * as schema from "../../db/drizzle/schema.ts";
import type {Ordering} from "../../db/ordering.ts";

// `id` breaks ties, which is what keeps the keyset cursor stable.
export const MECMUA_FEED_ORDERING: Ordering = [
	{field: "publishedAt", column: schema.mecmuaPost.publishedAt, dir: "desc"},
	{field: "id", column: schema.mecmuaPost.id, dir: "desc"},
];

// Ordered on `createdAt`, not `publishedAt`, because the author's own list includes
// drafts, whose `publishedAt` is null. Rides the `mecmua_post_author_created` index.
export const MECMUA_MINE_ORDERING: Ordering = [
	{field: "createdAt", column: schema.mecmuaPost.createdAt, dir: "desc"},
	{field: "id", column: schema.mecmuaPost.id, dir: "desc"},
];
