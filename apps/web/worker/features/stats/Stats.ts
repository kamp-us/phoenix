/**
 * Stats — the landing-page aggregate service.
 *
 * One read-only method: `getLandingStats` returns the four counters the SPA's
 * landing card needs. Three counters come from per-product single-row tables
 * (`sozluk_stats`, `pano_stats`); the fourth (`totalAuthors`) is a cross-product
 * UNION of distinct authors across `definition_view`, `post_summary`, and
 * `comment_view` (filtered to non-deleted rows).
 *
 * `sozluk_stats` and `pano_stats` are maintained inline by the feature services
 * (`SozlukLive` / `PanoLive`) — no projection layer. The single-row tables can
 * be missing on a fresh DB; we surface zeros rather than `null` so the SPA
 * always has something to render.
 *
 * Ported byte-for-byte from the legacy `landingStatsReader.ts` async function —
 * same three D1 reads, same fallback shape, same author-union query — wrapped
 * in `run` so the Drizzle dep stays in the layer and method types stay
 * `R = never`.
 */
import {sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, type DrizzleError} from "../../services/Drizzle";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface LandingStats {
	totalDefinitions: number;
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export class Stats extends Context.Service<
	Stats,
	{
		readonly getLandingStats: () => Effect.Effect<LandingStats, DrizzleError>;
	}
>()("@phoenix/stats/Stats") {}

/* -------------------------------------------------------------------------- */
/* Live layer                                                                  */
/* -------------------------------------------------------------------------- */

export const StatsLive = Layer.effect(Stats)(
	Effect.gen(function* () {
		const {run} = yield* Drizzle;

		return {
			getLandingStats: Effect.fn("Stats.getLandingStats")(function* () {
				// Three independent reads against single-row aggregate tables
				// plus a cross-product author UNION. The single-row tables can
				// be missing on a fresh DB — coalesce to zero so the resolver
				// always has a non-null shape to return.
				const sozlukRow = yield* run((db) =>
					db
						.run(sql`SELECT total_definitions FROM sozluk_stats WHERE id = 1`)
						.then((r) => (r.results[0] as {total_definitions: number} | undefined) ?? null),
				);
				const panoRow = yield* run((db) =>
					db
						.run(sql`SELECT total_posts, total_comments FROM pano_stats WHERE id = 1`)
						.then(
							(r) =>
								(r.results[0] as {total_posts: number; total_comments: number} | undefined) ?? null,
						),
				);
				// Cross-product distinct author union across the three view
				// tables. Cheaper than reading both per-product `total_authors`
				// columns since neither is a strict subset of the other.
				const authorsRow = yield* run((db) =>
					db
						.run(
							sql`SELECT COUNT(DISTINCT author_id) as n FROM (
								SELECT author_id FROM definition_view WHERE deleted_at IS NULL
								UNION
								SELECT author_id FROM post_summary WHERE deleted_at IS NULL
								UNION
								SELECT author_id FROM comment_view WHERE deleted_at IS NULL
							)`,
						)
						.then((r) => (r.results[0] as {n: number} | undefined) ?? null),
				);

				return {
					totalDefinitions: sozlukRow?.total_definitions ?? 0,
					totalPosts: panoRow?.total_posts ?? 0,
					totalComments: panoRow?.total_comments ?? 0,
					totalAuthors: authorsRow?.n ?? 0,
				} satisfies LandingStats;
			}),
		};
	}),
);
