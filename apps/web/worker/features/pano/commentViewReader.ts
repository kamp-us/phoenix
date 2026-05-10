/**
 * Cross-product `comment_view` lookup helpers.
 *
 * Powers the GraphQL `voteOnComment` / `retractCommentVote` resolvers, which
 * need to map a `commentId` back to its `postId` to route the RPC into the
 * correct per-post `PanoPost` DO (addressed by `idFromName(postId)`).
 *
 * Mirrors `lookupDefinitionTermSlug` (T5) — the projection denormalizes the
 * containing post id onto `comment_view` for exactly this kind of lookup.
 */
import {eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../view/drizzle/schema";

/**
 * Resolve a comment id back to its post id via the `comment_view` MV.
 *
 * Returns `null` if the projection hasn't landed yet OR the comment was
 * deleted; resolver translates either to a clean GraphQL error.
 */
export async function lookupCommentPostId(
	d1: D1Database,
	commentId: string,
): Promise<string | null> {
	const db = drizzle(d1, {schema});
	const row = await db
		.select({postId: schema.commentView.postId})
		.from(schema.commentView)
		.where(eq(schema.commentView.id, commentId))
		.limit(1);
	return row[0]?.postId ?? null;
}
