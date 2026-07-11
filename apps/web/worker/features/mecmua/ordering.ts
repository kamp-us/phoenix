/**
 * mecmua connection orderings the view `orderBy` and the service keyset share
 * (ADR 0019; see `db/ordering.ts`). Mirrors `features/pano/ordering.ts`, but the
 * subscribed-author feed is a TIME feed: it orders on `published_at` (newest-first),
 * not pano's `hot_score`.
 */

import * as schema from "../../db/drizzle/schema.ts";
import type {Ordering} from "../../db/ordering.ts";

/**
 * The subscribed-author feed (`mecmuaFeed`): `publishedAt desc, id desc` — newest
 * published post first, `id` breaking ties for a stable keyset cursor. Consumed by
 * the `mecmuaFeed` root's view `orderBy` and `Mecmua.listFeedConnection`'s keyset.
 */
export const MECMUA_FEED_ORDERING: Ordering = [
	{field: "publishedAt", column: schema.mecmuaPost.publishedAt, dir: "desc"},
	{field: "id", column: schema.mecmuaPost.id, dir: "desc"},
];
