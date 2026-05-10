/**
 * Read-side helper for the `posts(sort, limit, host)` resolver.
 *
 * The cross-entity post list reads from `PHOENIX_DB.post_summary` (the MV
 * maintained by `PhoenixProjection.PostChanged`), not from per-post DOs —
 * fanning out to every post DO would be O(n) RPCs per page render.
 *
 * Per-post reads (`post(idOrSlug)`, `postComments(postId)`) still RPC into
 * `PanoPost` for the full page (comments live there, not in the MV).
 */
import {and, desc, eq, isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../view/drizzle/schema";

export type PostSort = "hot" | "new" | "top" | "discuss";

/**
 * Mirrors the legacy `PostSummary` shape so the GraphQL `Post` type's
 * resolvers don't need new branches. `tags` is parsed from the comma-
 * separated `tags` column on `post_summary` and rendered as `{kind, label}`
 * pairs (label = kind for now; static enum mapping lives at the resolver
 * layer if richer labels are needed).
 */
export interface PostSummaryRow {
	id: string;
	slug: string | null;
	title: string;
	url: string | null;
	host: string | null;
	body: string | null;
	author: string;
	/** Author's Pasaport user id — powers the frontend's edit/delete gate (T9). */
	authorId: string;
	score: number;
	commentCount: number;
	createdAt: Date;
	tags: Array<{kind: string; label: string}>;
}

export async function listPostSummaries(
	d1: D1Database,
	opts: {sort?: PostSort; limit?: number; host?: string} = {},
): Promise<PostSummaryRow[]> {
	const sort = opts.sort ?? "hot";
	const limit = opts.limit ?? 50;
	const host = opts.host;
	const db = drizzle(d1, {schema});

	const where = host
		? and(eq(schema.postSummary.host, host), isNull(schema.postSummary.deletedAt))
		: isNull(schema.postSummary.deletedAt);

	const orderBy =
		sort === "new"
			? desc(schema.postSummary.createdAt)
			: sort === "top"
				? desc(schema.postSummary.score)
				: sort === "discuss"
					? desc(schema.postSummary.commentCount)
					: desc(schema.postSummary.hotScore);

	const rows = await db
		.select({
			id: schema.postSummary.id,
			slug: schema.postSummary.slug,
			title: schema.postSummary.title,
			url: schema.postSummary.url,
			host: schema.postSummary.host,
			bodyExcerpt: schema.postSummary.bodyExcerpt,
			authorId: schema.postSummary.authorId,
			authorName: schema.postSummary.authorName,
			score: schema.postSummary.score,
			commentCount: schema.postSummary.commentCount,
			createdAt: schema.postSummary.createdAt,
			tags: schema.postSummary.tags,
		})
		.from(schema.postSummary)
		.where(where)
		.orderBy(orderBy)
		.limit(limit);

	return rows.map((r) => ({
		id: r.id,
		slug: r.slug,
		title: r.title,
		url: r.url,
		host: r.host,
		body: r.bodyExcerpt,
		author: r.authorName,
		authorId: r.authorId,
		score: r.score,
		commentCount: r.commentCount,
		createdAt: r.createdAt ?? new Date(0),
		tags: parseTags(r.tags),
	}));
}

/**
 * Static label map for the fixed tag enum (per PRD: göster / tartışma /
 * soru / söylenme / meta). Falls back to the raw kind so unknown tags still
 * render. Keeping this client-side avoids denormalizing labels into D1.
 */
const TAG_LABELS: Record<string, string> = {
	show: "göster",
	discuss: "tartışma",
	ask: "soru",
	rant: "söylenme",
	meta: "meta",
};

function parseTags(csv: string): Array<{kind: string; label: string}> {
	if (!csv) return [];
	return csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((kind) => ({kind, label: TAG_LABELS[kind] ?? kind}));
}
