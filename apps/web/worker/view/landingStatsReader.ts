/**
 * Landing-page stats reader (T15).
 *
 * Reads the single-row aggregates from `sozluk_stats` and `pano_stats` —
 * maintained by the `PhoenixProjection` workflow on every event that touches
 * the underlying view tables. `totalAuthors` is the union across both
 * products: distinct authors who have any non-deleted contribution in either
 * sozluk (definition_view) or pano (post_summary, comment_view).
 *
 * Both single-row tables can be missing on a fresh DB — we surface zeros
 * rather than null so the SPA always has something to render.
 */

export interface LandingStats {
	totalDefinitions: number;
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
}

export async function readLandingStats(db: D1Database): Promise<LandingStats> {
	const [sozluk, pano, authors] = await Promise.all([
		db
			.prepare("SELECT total_definitions FROM sozluk_stats WHERE id = 1")
			.first<{total_definitions: number}>(),
		db
			.prepare("SELECT total_posts, total_comments FROM pano_stats WHERE id = 1")
			.first<{total_posts: number; total_comments: number}>(),
		// Cross-product distinct author union. Cheaper than reading both
		// per-product `total_authors` columns since neither is a strict subset
		// of the other; UNION across the three view tables yields the right
		// answer in one query.
		db
			.prepare(
				`SELECT COUNT(DISTINCT author_id) as n FROM (
					SELECT author_id FROM definition_view WHERE deleted_at IS NULL
					UNION
					SELECT author_id FROM post_summary WHERE deleted_at IS NULL
					UNION
					SELECT author_id FROM comment_view WHERE deleted_at IS NULL
				)`,
			)
			.first<{n: number}>(),
	]);
	return {
		totalDefinitions: sozluk?.total_definitions ?? 0,
		totalPosts: pano?.total_posts ?? 0,
		totalComments: pano?.total_comments ?? 0,
		totalAuthors: authors?.n ?? 0,
	};
}
