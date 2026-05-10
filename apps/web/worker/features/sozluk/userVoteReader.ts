/**
 * Cross-product `user_vote` lookup helper.
 *
 * Powers the `myVote` GraphQL field on `Definition` (T5), and later on `Post`
 * (T8) and `Comment` (T11). Voting is up-only in the MVP — presence of a row
 * means the user has voted; absence means they haven't. Returns 1 / null
 * directly so resolver bodies stay one-liners.
 *
 * Lookup is single-row by composite PK (`user_id`, `target_kind`, `target_id`),
 * so no index hints needed beyond the PK itself.
 */
import {and, eq} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../view/drizzle/schema";

export type VoteTargetKind = "definition" | "post" | "comment";

/**
 * Resolve a definition id back to its term slug via the `definition_view` MV.
 * The vote mutations only take a `definitionId`, but the per-term Agent is
 * addressed by `idFromName(slug)` — the projection denormalizes the slug onto
 * `definition_view` for exactly this lookup.
 *
 * Returns `null` if the projection hasn't landed yet OR the definition was
 * deleted; resolver translates either to a clean GraphQL error.
 */
export async function lookupDefinitionTermSlug(
	d1: D1Database,
	definitionId: string,
): Promise<string | null> {
	const db = drizzle(d1, {schema});
	const row = await db
		.select({termSlug: schema.definitionView.termSlug})
		.from(schema.definitionView)
		.where(eq(schema.definitionView.id, definitionId))
		.limit(1);
	return row[0]?.termSlug ?? null;
}

export async function readMyVote(
	d1: D1Database,
	args: {userId: string; targetKind: VoteTargetKind; targetId: string},
): Promise<number | null> {
	const db = drizzle(d1, {schema});
	const row = await db
		.select({userId: schema.userVote.userId})
		.from(schema.userVote)
		.where(
			and(
				eq(schema.userVote.userId, args.userId),
				eq(schema.userVote.targetKind, args.targetKind),
				eq(schema.userVote.targetId, args.targetId),
			),
		)
		.limit(1);
	return row.length > 0 ? 1 : null;
}
