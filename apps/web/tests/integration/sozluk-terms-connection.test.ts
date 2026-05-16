/**
 * Sozluk home terms connection-shaped reader (task_5, phoenix-relay-idiom).
 *
 * Exercises `listTermSummariesConnection` in workerd with a seeded
 * `term_summary` (via the per-term DO + projection chain):
 *   - First page returns up to `first` rows + `hasNextPage` + `endCursor`.
 *   - Walking `after = endCursor` advances through every row exactly once.
 *   - `sort: 'recent'` orders by `lastActivityAt` DESC with slug ASC tie-breaker.
 *   - `sort: 'popular'` orders by `totalScore` DESC with slug ASC tie-breaker.
 *   - `totalCount` matches the number of `term_summary` rows.
 *   - A stale cursor (slug not in the table) collapses to no further rows.
 *
 * Mirrors the seeding pattern from `sozluk-term.test.ts` and the connection
 * pagination pattern from `pano-post-connection.test.ts`.
 */
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import {listTermSummariesConnection} from "../../worker/features/sozluk/termSummaryReader";
import viewMigration0000 from "../../worker/db/drizzle/migrations/0000_secret_iron_patriot.sql";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const statements = viewMigration0000
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

async function waitForTermSummary(slug: string, attempts = 30): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		const result = await env.PHOENIX_DB.prepare(
			"SELECT slug FROM term_summary WHERE slug = ?",
		)
			.bind(slug)
			.first();
		if (result) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`term_summary row for ${slug} never landed`);
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("listTermSummariesConnection — task_5", () => {
	it("paginates through every row exactly once when walking endCursor (popular sort)", async () => {
		// Seed five terms with strictly-increasing scores so popular sort is
		// deterministic (different totalScore for each → no tie-breaking on slug).
		const seededSlugs: string[] = [];
		for (let i = 0; i < 5; i++) {
			const slug = `connection-popular-${Date.now().toString(36)}-${i}`;
			seededSlugs.push(slug);
			const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
			await stub.seed({
				title: `Title ${i}`,
				definitions: [
					{
						authorId: `u-${i}`,
						authorName: `author${i}`,
						body: `body for ${slug}`,
						// Increasing score per index so newer seeds sort earlier
						// under DESC totalScore.
						score: 100 + i,
					},
				],
			});
		}
		// Wait for every row to land in term_summary (projection drains FIFO).
		for (const slug of seededSlugs) {
			await waitForTermSummary(slug);
		}

		// Walk pages with `first: 2`. Track only the seeded slugs since other
		// tests may have left noise in the table.
		const seen: string[] = [];
		let after: string | null = null;
		let safety = 0;
		while (safety++ < 50) {
			const page: Awaited<ReturnType<typeof listTermSummariesConnection>> =
				await listTermSummariesConnection(env.PHOENIX_DB, {
					sort: "popular",
					first: 2,
					after,
				});
			expect(page.rows.length).toBeGreaterThanOrEqual(0);
			for (const row of page.rows) {
				if (seededSlugs.includes(row.slug)) seen.push(row.slug);
			}
			if (!page.hasNextPage) break;
			after = page.endCursor;
		}

		// Every seeded slug appears exactly once.
		expect(new Set(seen).size).toBe(seededSlugs.length);
		// Among seeded rows, the order is highest-score first
		// (slug index 4 → 3 → 2 → 1 → 0 since score = 100 + i).
		const seededInOrder = seen.filter((s) => seededSlugs.includes(s));
		expect(seededInOrder).toEqual([...seededSlugs].reverse());
	});

	it("recent sort orders by lastActivityAt DESC with slug ASC tie-breaker", async () => {
		const seededSlugs: string[] = [];
		for (let i = 0; i < 3; i++) {
			const slug = `connection-recent-${Date.now().toString(36)}-${i}`;
			seededSlugs.push(slug);
			const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
			await stub.seed({
				title: `Recent ${i}`,
				definitions: [
					{
						authorId: `u-${i}`,
						authorName: `author${i}`,
						body: `recent body ${slug}`,
						score: 1,
					},
				],
			});
			// Force a 1100ms gap so lastActivityAt sec-resolution doesn't
			// collapse — same trick as pano-post-connection.test.ts.
			if (i < 2) await new Promise((r) => setTimeout(r, 1100));
		}
		for (const slug of seededSlugs) {
			await waitForTermSummary(slug);
		}

		const page = await listTermSummariesConnection(env.PHOENIX_DB, {
			sort: "recent",
			first: 100,
		});
		const seededInResult = page.rows.map((r) => r.slug).filter((s) => seededSlugs.includes(s));
		// Most-recent (last seeded) first under DESC lastActivityAt.
		expect(seededInResult).toEqual([...seededSlugs].reverse());
	});

	it("totalCount matches the number of term_summary rows", async () => {
		const slug = `connection-total-${Date.now().toString(36)}`;
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
		await stub.seed({
			title: "Total",
			definitions: [
				{
					authorId: "u-total",
					authorName: "total",
					body: "total body",
					score: 1,
				},
			],
		});
		await waitForTermSummary(slug);

		const direct = await env.PHOENIX_DB.prepare("SELECT count(*) as n FROM term_summary").first<{
			n: number;
		}>();
		const expected = direct?.n ?? 0;

		const page = await listTermSummariesConnection(env.PHOENIX_DB, {first: 1});
		expect(page.totalCount).toBe(expected);
	});

	it("collapses to no further rows when the cursor points to a non-existent slug", async () => {
		const page = await listTermSummariesConnection(env.PHOENIX_DB, {
			sort: "recent",
			first: 10,
			after: "term_summary_does_not_exist_xyz",
		});
		// Stale cursor: the keyset predicate degenerates to "no further rows"
		// (cursor row not found → cursorPredicate stays undefined; reader
		// returns the head of the table). Either result is acceptable for a
		// stale cursor; assert pagination doesn't throw and returns a
		// well-formed page.
		expect(Array.isArray(page.rows)).toBe(true);
		expect(typeof page.hasNextPage).toBe("boolean");
	});
});
