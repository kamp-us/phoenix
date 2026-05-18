/**
 * Landing stats projection — sozluk_stats + pano_stats kept current
 * by the same projection steps that touch the underlying view tables.
 *
 * Exercises end-to-end inside workerd:
 *   1. Apply the D1 view migrations.
 *   2. Drive `addDefinition` and `submitPost` / `addComment` through different
 *      authors and verify the single-row aggregates land:
 *      - sozluk_stats: total_definitions, total_authors (distinct authors)
 *      - pano_stats: total_posts, total_comments, total_authors (distinct
 *        across posts + comments)
 *   3. Soft-delete a definition → total_definitions decrements; the author's
 *      remaining definitions keep them in the distinct count.
 */
import {env} from "cloudflare:workers";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {addComment, submitPost} from "../../worker/features/pano/module";
import {addDefinition, deleteDefinition} from "../../worker/features/sozluk/module";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [baselineMigration];
	for (const src of sources) {
		const statements = src
			.split("--> statement-breakpoint")
			.map((s: string) => s.trim())
			.filter(Boolean);
		for (const stmt of statements) {
			try {
				await env.PHOENIX_DB.prepare(stmt).run();
			} catch (err) {
				const msg = String(err);
				if (
					!msg.includes("already exists") &&
					!msg.includes("duplicate column") &&
					!msg.includes("no such table") &&
					!msg.includes("no such index")
				) {
					throw err;
				}
			}
		}
	}
}

async function waitFor<T>(check: () => Promise<T | null>, attempts = 30): Promise<T | null> {
	for (let i = 0; i < attempts; i++) {
		const v = await check();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function readSozlukStats(): Promise<{
	totalDefinitions: number;
	totalAuthors: number;
} | null> {
	const row = await env.PHOENIX_DB.prepare(
		"SELECT total_definitions, total_authors FROM sozluk_stats WHERE id = 1",
	).first<{total_definitions: number; total_authors: number}>();
	if (!row) return null;
	return {totalDefinitions: row.total_definitions, totalAuthors: row.total_authors};
}

async function readPanoStats(): Promise<{
	totalPosts: number;
	totalComments: number;
	totalAuthors: number;
} | null> {
	const row = await env.PHOENIX_DB.prepare(
		"SELECT total_posts, total_comments, total_authors FROM pano_stats WHERE id = 1",
	).first<{total_posts: number; total_comments: number; total_authors: number}>();
	if (!row) return null;
	return {
		totalPosts: row.total_posts,
		totalComments: row.total_comments,
		totalAuthors: row.total_authors,
	};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("landing stats projection", () => {
	it("sozluk_stats reflects total_definitions + total_authors after adds and deletes", async () => {
		// Two distinct authors writing on two distinct slugs.
		const authorA = "user_stats_sozluk_a";
		const authorB = "user_stats_sozluk_b";

		const slugA = "stats-sozluk-alpha";
		const slugB = "stats-sozluk-beta";

		const aDef = await addDefinition(env, {
			termSlug: slugA,
			authorId: authorA,
			authorName: "Author A",
			body: "stats sozluk alpha by A",
			termTitle: "Stats Sozluk Alpha",
		});

		await addDefinition(env, {
			termSlug: slugB,
			authorId: authorB,
			authorName: "Author B",
			body: "stats sozluk beta by B",
			termTitle: "Stats Sozluk Beta",
		});

		// authorA writes a second definition on slugB to verify distinct-count
		// (still 2 authors, not 3).
		await addDefinition(env, {
			termSlug: slugB,
			authorId: authorA,
			authorName: "Author A",
			body: "stats sozluk beta by A also",
			termTitle: "Stats Sozluk Beta",
		});

		// Wait for projection to converge: 3 definitions for these two authors.
		const after3 = await waitFor(async () => {
			const stats = await readSozlukStats();
			if (!stats) return null;
			// Use a count query to avoid coupling to other tests' totals.
			const row = await env.PHOENIX_DB.prepare(
				"SELECT COUNT(*) as n FROM definition_view WHERE author_id IN (?, ?) AND deleted_at IS NULL",
			)
				.bind(authorA, authorB)
				.first<{n: number}>();
			return row && row.n === 3 ? stats : null;
		});
		expect(after3).not.toBeNull();

		// At minimum the stats row exists with both authors counted.
		// We can't assume isolation, so just assert the count matches the
		// distinct authors actually represented in definition_view.
		const distinctAuthorsRow = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(DISTINCT author_id) as n FROM definition_view WHERE deleted_at IS NULL",
		).first<{n: number}>();
		expect(after3!.totalAuthors).toBe(distinctAuthorsRow!.n);

		const distinctDefsRow = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_view WHERE deleted_at IS NULL",
		).first<{n: number}>();
		expect(after3!.totalDefinitions).toBe(distinctDefsRow!.n);

		// Soft-delete A's first definition → total_definitions ticks down.
		await deleteDefinition(env, {definitionId: aDef.definitionId, actorId: authorA});

		const afterDelete = await waitFor(async () => {
			const stats = await readSozlukStats();
			if (!stats) return null;
			const row = await env.PHOENIX_DB.prepare(
				"SELECT deleted_at FROM definition_view WHERE id = ?",
			)
				.bind(aDef.definitionId)
				.first<{deleted_at: number | null}>();
			return row && row.deleted_at != null ? stats : null;
		});
		expect(afterDelete).not.toBeNull();

		const distinctDefsAfterDelete = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_view WHERE deleted_at IS NULL",
		).first<{n: number}>();
		expect(afterDelete!.totalDefinitions).toBe(distinctDefsAfterDelete!.n);

		// authorA still has another definition on slugB so they remain a distinct
		// author. Verify total_authors == distinct authors over non-deleted rows.
		const distinctAuthorsAfter = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(DISTINCT author_id) as n FROM definition_view WHERE deleted_at IS NULL",
		).first<{n: number}>();
		expect(afterDelete!.totalAuthors).toBe(distinctAuthorsAfter!.n);
	});

	it("pano_stats reflects posts + comments + distinct authors across both", async () => {
		const authorA = "user_stats_pano_a";
		const authorB = "user_stats_pano_b";

		const post = await submitPost(env, {
			title: "stats pano one",
			url: "https://example.com/stats-pano-one",
			body: "pano stats body",
			tags: [{kind: "tartışma"}],
			authorId: authorA,
			authorName: "Author A",
		});
		const postId = post.postId;

		// authorB drops a comment on authorA's post.
		await addComment(env, {
			postId,
			authorId: authorB,
			authorName: "Author B",
			body: "stats pano comment from B",
		});

		// authorA also comments on their own post (already an author via post).
		await addComment(env, {
			postId,
			authorId: authorA,
			authorName: "Author A",
			body: "stats pano comment from A self",
		});

		// Wait for projection to land both comments + the post row.
		const converged = await waitFor(async () => {
			const stats = await readPanoStats();
			if (!stats) return null;
			const post = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
				.bind(postId)
				.first();
			const commentCount = await env.PHOENIX_DB.prepare(
				"SELECT COUNT(*) as n FROM comment_view WHERE post_id = ? AND deleted_at IS NULL",
			)
				.bind(postId)
				.first<{n: number}>();
			return post && commentCount && commentCount.n === 2 ? stats : null;
		});
		expect(converged).not.toBeNull();

		// The aggregates should equal the live-derived counts.
		const totalPostsRow = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM post_summary WHERE deleted_at IS NULL",
		).first<{n: number}>();
		expect(converged!.totalPosts).toBe(totalPostsRow!.n);

		const totalCommentsRow = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM comment_view WHERE deleted_at IS NULL",
		).first<{n: number}>();
		expect(converged!.totalComments).toBe(totalCommentsRow!.n);

		// total_authors for pano = distinct(author_id) across post_summary +
		// comment_view (both filtered to non-deleted rows).
		const distinctAuthorsRow = await env.PHOENIX_DB.prepare(
			`SELECT COUNT(DISTINCT author_id) as n FROM (
				SELECT author_id FROM post_summary WHERE deleted_at IS NULL
				UNION
				SELECT author_id FROM comment_view WHERE deleted_at IS NULL
			)`,
		).first<{n: number}>();
		expect(converged!.totalAuthors).toBe(distinctAuthorsRow!.n);
	});
});
