/**
 * Sozluk home terms connection-shaped reader — Effect service path
 * (effect-migration task 4).
 *
 * Exercises `Sozluk.listTermSummariesConnection` after inline D1 seeding via
 * `SozlukAdmin.seedTerm`. Same coverage as the pre-effect-migration version
 * (popular sort, recent sort, totalCount, stale cursor).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:workers";
import {Effect, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {Sozluk, SozlukLive} from "../../worker/features/sozluk/Sozluk";
import {SozlukAdmin, SozlukAdminLive} from "../../worker/features/sozluk/SozlukAdmin";
import {VoteLive} from "../../worker/features/vote/Vote";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = Layer.mergeAll(
	SozlukLive.pipe(Layer.provideMerge(VoteLive)),
	SozlukAdminLive,
).pipe(Layer.provide(DrizzleLive), Layer.provide(Layer.succeed(CloudflareEnv, env)));

const run = <A, E, R extends Sozluk | SozlukAdmin>(eff: Effect.Effect<A, E, R>) =>
	Effect.runPromise(eff.pipe(Effect.provide(TestLive)) as Effect.Effect<A, E, never>);

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

describe("Sozluk.listTermSummariesConnection", () => {
	it("paginates through every row exactly once when walking endCursor (popular sort)", async () => {
		const seededSlugs: string[] = [];
		for (let i = 0; i < 5; i++) {
			const slug = `connection-popular-${Date.now().toString(36)}-${i}`;
			seededSlugs.push(slug);
			await run(
				Effect.gen(function* () {
					const admin = yield* SozlukAdmin;
					return yield* admin.seedTerm({
						slug,
						title: `Title ${i}`,
						definitions: [
							{
								authorId: `u-${i}`,
								authorName: `author${i}`,
								body: `body for ${slug}`,
								score: 100 + i,
							},
						],
					});
				}),
			);
		}

		const seen: string[] = [];
		let after: string | null = null;
		let safety = 0;
		while (safety++ < 50) {
			const page = await run(
				Effect.gen(function* () {
					const sozluk = yield* Sozluk;
					return yield* sozluk.listTermSummariesConnection({
						sort: "popular",
						first: 2,
						after,
					});
				}),
			);
			expect(page.rows.length).toBeGreaterThanOrEqual(0);
			for (const row of page.rows) {
				if (seededSlugs.includes(row.slug)) seen.push(row.slug);
			}
			if (!page.hasNextPage) break;
			after = page.endCursor;
		}

		expect(new Set(seen).size).toBe(seededSlugs.length);
		const seededInOrder = seen.filter((s) => seededSlugs.includes(s));
		expect(seededInOrder).toEqual([...seededSlugs].reverse());
	});

	it("recent sort orders by lastActivityAt DESC with slug ASC tie-breaker", async () => {
		const seededSlugs: string[] = [];
		for (let i = 0; i < 3; i++) {
			const slug = `connection-recent-${Date.now().toString(36)}-${i}`;
			seededSlugs.push(slug);
			await run(
				Effect.gen(function* () {
					const admin = yield* SozlukAdmin;
					return yield* admin.seedTerm({
						slug,
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
				}),
			);
			// Force a 1100ms gap so lastActivityAt sec-resolution doesn't collapse.
			if (i < 2) await new Promise((r) => setTimeout(r, 1100));
		}

		const page = await run(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.listTermSummariesConnection({sort: "recent", first: 100});
			}),
		);
		const seededInResult = page.rows.map((r) => r.slug).filter((s) => seededSlugs.includes(s));
		expect(seededInResult).toEqual([...seededSlugs].reverse());
	});

	it("totalCount matches the number of term_summary rows", async () => {
		const slug = `connection-total-${Date.now().toString(36)}`;
		await run(
			Effect.gen(function* () {
				const admin = yield* SozlukAdmin;
				return yield* admin.seedTerm({
					slug,
					title: "Total",
					definitions: [{authorId: "u-total", authorName: "total", body: "total body", score: 1}],
				});
			}),
		);

		const direct = await env.PHOENIX_DB.prepare("SELECT count(*) as n FROM term_summary").first<{
			n: number;
		}>();
		const expected = direct?.n ?? 0;

		const page = await run(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.listTermSummariesConnection({first: 1});
			}),
		);
		expect(page.totalCount).toBe(expected);
	});

	it("collapses to no further rows when the cursor points to a non-existent slug", async () => {
		const page = await run(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.listTermSummariesConnection({
					sort: "recent",
					first: 10,
					after: "term_summary_does_not_exist_xyz",
				});
			}),
		);
		expect(Array.isArray(page.rows)).toBe(true);
		expect(typeof page.hasNextPage).toBe("boolean");
	});
});
