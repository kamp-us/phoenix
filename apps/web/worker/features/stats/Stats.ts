/**
 * Stats — the landing-page aggregate service. One read-only method,
 * `getLandingStats`, returns the SPA's four counters: three from per-product
 * single-row tables (`sozluk_stats`, `pano_stats`, maintained inline by the
 * feature services), the fourth a distinct-author UNION across the view tables.
 *
 * Reads go through `run`/`orDieAccess`, so infra failures die here (the
 * domain-boundary rule) and the public signature carries no error.
 */
import {sql} from "drizzle-orm";
import {Context, Effect, Layer} from "effect";
import {Drizzle, orDieAccess} from "../../db/Drizzle.ts";

export interface LandingStats {
	totalDefinitions: number;
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
}

export class Stats extends Context.Service<
	Stats,
	{
		readonly getLandingStats: () => Effect.Effect<LandingStats>;
	}
>()("@kampus/stats/Stats") {}

export const StatsLive = Layer.effect(Stats)(
	Effect.gen(function* () {
		const {run} = orDieAccess(yield* Drizzle);

		return {
			getLandingStats: Effect.fn("Stats.getLandingStats")(function* () {
				// The single-row tables can be missing on a fresh DB — coalesce to
				// zero (below) so the resolver always has a non-null shape.
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
				// Distinct-author UNION across the view tables: cheaper than reading
				// both per-product `total_authors` columns, since neither is a strict
				// subset of the other.
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
