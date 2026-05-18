/**
 * Pano feed connection-shaped reader — Effect service surface
 * (effect-migration task 5).
 *
 * Exercises `Pano.listPostsConnection` in workerd with `post_summary` rows
 * seeded via `Pano.submitPost`.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:workers";
import {Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {Pano, PanoLive, type SubmitPostInput} from "../../worker/features/pano/Pano";
import {VoteLive} from "../../worker/features/vote/Vote";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = PanoLive.pipe(
	Layer.provideMerge(VoteLive),
	Layer.provide(DrizzleLive),
	Layer.provide(Layer.succeed(CloudflareEnv, env)),
);

function submitPost(input: SubmitPostInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.submitPost(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function listPostsConnection(opts: {
	sort?: "hot" | "new" | "top" | "discuss";
	first?: number;
	host?: string | null;
	after?: string | null;
}) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.listPostsConnection(opts);
		}).pipe(Effect.provide(TestLive)),
	);
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

describe("Pano.listPostsConnection", () => {
	it("paginates through every row exactly once when walking endCursor", async () => {
		const host = `paginate-${Date.now().toString(36)}.example.com`;
		const seededIds: string[] = [];
		for (let i = 0; i < 5; i++) {
			const result = await submitPost({
				title: `title ${i}`,
				url: `https://${host}/p/${i}`,
				tags: [{kind: "tartışma"}],
				authorId: "author-1",
				authorName: "umut",
			});
			seededIds.push(result.postId);
			if (i < 4) await new Promise((r) => setTimeout(r, 1100));
		}

		const page1 = await listPostsConnection({sort: "new", first: 2, host});
		expect(page1.rows).toHaveLength(2);
		expect(page1.hasNextPage).toBe(true);
		expect(page1.endCursor).toBe(page1.rows[1]!.id);
		expect(page1.totalCount).toBe(5);

		const page2 = await listPostsConnection({
			sort: "new",
			first: 2,
			host,
			after: page1.endCursor,
		});
		expect(page2.rows).toHaveLength(2);
		expect(page2.hasNextPage).toBe(true);
		expect(page2.endCursor).toBe(page2.rows[1]!.id);

		const page3 = await listPostsConnection({
			sort: "new",
			first: 2,
			host,
			after: page2.endCursor,
		});
		expect(page3.rows).toHaveLength(1);
		expect(page3.hasNextPage).toBe(false);
		expect(page3.endCursor).toBe(page3.rows[0]!.id);

		const collected = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
		expect(new Set(collected).size).toBe(5);
		expect(collected).toEqual([...seededIds].reverse());
	});

	it("totalCount reflects the non-deleted rows under the active host filter", async () => {
		const host = `total-${Date.now().toString(36)}.example.com`;
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const result = await submitPost({
				title: `title ${i}`,
				url: `https://${host}/p/${i}`,
				tags: [{kind: "meta"}],
				authorId: "author-2",
				authorName: "indexer",
			});
			ids.push(result.postId);
		}

		const page = await listPostsConnection({first: 100, host});
		expect(page.totalCount).toBe(3);
		expect(page.rows).toHaveLength(3);
		expect(page.hasNextPage).toBe(false);
		expect(page.endCursor).toBe(page.rows[page.rows.length - 1]!.id);
	});

	it("collapses to no further rows when the cursor points to a since-deleted post", async () => {
		const host = `stale-${Date.now().toString(36)}.example.com`;
		await submitPost({
			title: "the only one",
			url: `https://${host}/x`,
			tags: [{kind: "meta"}],
			authorId: "author-3",
			authorName: "stale",
		});
		const ghostId = "post_DOES_NOT_EXIST";
		const page = await listPostsConnection({first: 10, host, after: ghostId});
		expect(page.rows).toHaveLength(0);
		expect(page.hasNextPage).toBe(false);
	});
});
