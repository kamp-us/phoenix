/**
 * Cross-product `comment_view` lookup helpers.
 *
 * Pre-d1-direct, the GraphQL `voteOnComment` / `retractCommentVote` resolvers
 * needed to map a `commentId` back to its `postId` to route the RPC into the
 * correct per-post DO. After the D1-direct refactor every comment write hits
 * `PHOENIX_DB` directly and the resolvers no longer need this lookup; the
 * helper is kept for future cross-table jumps (e.g. notification fan-out).
 */
import {eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../db/drizzle/schema";

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
