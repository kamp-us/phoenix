/**
 * Pano feed connection-shaped reader.
 *
 * Exercises `listPostConnection` in workerd with `post_summary` rows
 * seeded via the D1-direct `submitPost` module function.
 *
 * No `runInDurableObject`, no projection workflow — writes are inline
 * D1 (ADR 0009).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:workers";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {submitPost} from "../../worker/features/pano/module";
import {listPostConnection} from "../../worker/features/pano/postSummaryReader";

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

beforeAll(async () => {
	await applyViewMigrations();
});

describe("listPostConnection (d1-direct seeded)", () => {
	it("paginates through every row exactly once when walking endCursor", async () => {
		// Seed five posts under a unique host so we can isolate from any
		// noise other tests left in `post_summary`.
		const host = `paginate-${Date.now().toString(36)}.example.com`;
		const seededIds: string[] = [];
		for (let i = 0; i < 5; i++) {
			const result = await submitPost(env, {
				title: `title ${i}`,
				url: `https://${host}/p/${i}`,
				tags: [{kind: "tartışma"}],
				authorId: "author-1",
				authorName: "umut",
			});
			seededIds.push(result.postId);
			// Force a 1100ms gap so created_at sec-resolution doesn't collapse
			// rows onto the same timestamp.
			if (i < 4) await new Promise((r) => setTimeout(r, 1100));
		}

		// Page 1 — `first: 2`.
		const page1 = await listPostConnection(env.PHOENIX_DB, {sort: "new", first: 2, host});
		expect(page1.rows).toHaveLength(2);
		expect(page1.hasNextPage).toBe(true);
		expect(page1.endCursor).toBe(page1.rows[1]!.id);
		expect(page1.totalCount).toBe(5);

		// Page 2 — walk endCursor.
		const page2 = await listPostConnection(env.PHOENIX_DB, {
			sort: "new",
			first: 2,
			host,
			after: page1.endCursor,
		});
		expect(page2.rows).toHaveLength(2);
		expect(page2.hasNextPage).toBe(true);
		expect(page2.endCursor).toBe(page2.rows[1]!.id);

		// Page 3 — last row, no further pages.
		const page3 = await listPostConnection(env.PHOENIX_DB, {
			sort: "new",
			first: 2,
			host,
			after: page2.endCursor,
		});
		expect(page3.rows).toHaveLength(1);
		expect(page3.hasNextPage).toBe(false);
		expect(page3.endCursor).toBe(page3.rows[0]!.id);

		// Every seeded id appeared exactly once across the three pages, in
		// reverse insertion order (newest first under `sort: 'new'`).
		const collected = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
		expect(new Set(collected).size).toBe(5);
		expect(collected).toEqual([...seededIds].reverse());
	});

	it("totalCount reflects the non-deleted rows under the active host filter", async () => {
		const host = `total-${Date.now().toString(36)}.example.com`;
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const result = await submitPost(env, {
				title: `title ${i}`,
				url: `https://${host}/p/${i}`,
				tags: [{kind: "meta"}],
				authorId: "author-2",
				authorName: "indexer",
			});
			ids.push(result.postId);
		}

		const page = await listPostConnection(env.PHOENIX_DB, {first: 100, host});
		expect(page.totalCount).toBe(3);
		expect(page.rows).toHaveLength(3);
		expect(page.hasNextPage).toBe(false);
		expect(page.endCursor).toBe(page.rows[page.rows.length - 1]!.id);
	});

	it("collapses to no further rows when the cursor points to a since-deleted post", async () => {
		const host = `stale-${Date.now().toString(36)}.example.com`;
		await submitPost(env, {
			title: "the only one",
			url: `https://${host}/x`,
			tags: [{kind: "meta"}],
			authorId: "author-3",
			authorName: "stale",
		});
		// Cursor that doesn't exist in the table.
		const ghostId = "post_DOES_NOT_EXIST";
		const page = await listPostConnection(env.PHOENIX_DB, {first: 10, host, after: ghostId});
		// Stale cursor: the keyset predicate becomes "no further rows",
		// the result is empty. The FE then re-fetches from the head, which
		// is the right behavior for a stale cursor.
		expect(page.rows).toHaveLength(0);
		expect(page.hasNextPage).toBe(false);
	});
});
