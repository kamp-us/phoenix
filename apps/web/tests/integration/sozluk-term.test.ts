/**
 * Sozluk read paths — Effect service path (effect-migration task 4).
 *
 * Exercises end-to-end inside workerd:
 *   1. Apply D1 view migrations (including 0005 for d1-direct sozluk).
 *   2. Seed a term via `SozlukAdmin.seedTerm` (replaces the DO seed).
 *   3. Verify `Sozluk.getTerm` returns the expected `TermPage` shape.
 *   4. Verify `term_summary` was written inline.
 *   5. Verify `Sozluk.listTermSummaries` reflects the row.
 *   6. Verify `seedTerm` is idempotent (re-seeding skips duplicates).
 *   7. Verify `clearAllTerms` wipes the slug's row + definitions.
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

const run = <A, E, R extends Sozluk | SozlukAdmin>(eff: Effect.Effect<A, E, R>) =>
	Effect.runPromise(eff.pipe(Effect.provide(TestLive)) as Effect.Effect<A, E, never>);

beforeAll(async () => {
	await applyViewMigrations();
});

describe("sozluk read paths", () => {
	it("seedTerm writes inline; getTerm + listTermSummaries reflect the row", async () => {
		const slug = "agent";
		const result = await run(
			Effect.gen(function* () {
				const admin = yield* SozlukAdmin;
				return yield* admin.seedTerm({
					slug,
					title: "Agent",
					definitions: [
						{
							authorId: "u1",
							authorName: "umut",
							body: "An autonomous reasoning entity that orchestrates other tools.",
							score: 5,
						},
						{
							authorId: "u2",
							authorName: "elif",
							body: "Cloudflare Agent base class — typed Durable Object with state sync.",
							score: 3,
						},
					],
				});
			}),
		);

		expect(result.created).toBe(true);
		expect(result.insertedDefinitions).toBe(2);
		expect(result.skippedDefinitions).toBe(0);

		const term = await run(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm(slug);
			}),
		);
		expect(term).not.toBeNull();
		expect(term!.slug).toBe(slug);
		expect(term!.title).toBe("Agent");
		expect(term!.totalDefinitions).toBe(2);
		expect(term!.totalScore).toBe(8);
		// Highest-score definition first.
		expect(term!.definitions[0]!.score).toBe(5);
		expect(term!.definitions[1]!.score).toBe(3);

		const summaries = await run(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.listTermSummaries({sort: "popular", limit: 10});
			}),
		);
		const summary = summaries.find((s) => s.slug === slug);
		expect(summary).toBeDefined();
		expect(summary!.title).toBe("Agent");
		expect(summary!.count).toBe(2);
		expect(summary!.totalScore).toBe(8);
		expect(summary!.excerpt).toContain("autonomous reasoning entity");
	});

	it("getTerm returns null when no term row exists for the slug", async () => {
		const term = await run(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm("never-existed");
			}),
		);
		expect(term).toBeNull();
	});

	it("seedTerm is idempotent: re-seeding the same definition is a no-op", async () => {
		const slug = "outbox";
		const def = {
			authorId: "u1",
			authorName: "umut",
			body: "Atomic durability primitive in the producer-consumer outbox pattern.",
		};

		const first = await run(
			Effect.gen(function* () {
				const admin = yield* SozlukAdmin;
				return yield* admin.seedTerm({slug, title: "Outbox", definitions: [def]});
			}),
		);
		expect(first.insertedDefinitions).toBe(1);
		expect(first.skippedDefinitions).toBe(0);

		const second = await run(
			Effect.gen(function* () {
				const admin = yield* SozlukAdmin;
				return yield* admin.seedTerm({slug, title: "Outbox", definitions: [def]});
			}),
		);
		expect(second.insertedDefinitions).toBe(0);
		expect(second.skippedDefinitions).toBe(1);

		const term = await run(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm(slug);
			}),
		);
		expect(term!.totalDefinitions).toBe(1);
	});

	it("clearAllTerms wipes the slug's term_summary + definition_view rows", async () => {
		const slug = "transient";
		await run(
			Effect.gen(function* () {
				const admin = yield* SozlukAdmin;
				return yield* admin.seedTerm({
					slug,
					title: "Transient",
					definitions: [{authorId: "u1", authorName: "umut", body: "Short-lived state."}],
				});
			}),
		);

		const cleared = await run(
			Effect.gen(function* () {
				const admin = yield* SozlukAdmin;
				return yield* admin.clearAllTerms([slug]);
			}),
		);
		expect(cleared.terms).toBe(1);
		expect(cleared.definitions).toBe(1);

		const empty = await run(
			Effect.gen(function* () {
				const sozluk = yield* Sozluk;
				return yield* sozluk.getTerm(slug);
			}),
		);
		expect(empty).toBeNull();
	});
});
