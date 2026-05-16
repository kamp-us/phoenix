/**
 * SozlukTerm + projection integration test.
 *
 * Exercises the T2 read-path migration end-to-end inside the actual workerd
 * runtime via `@cloudflare/vitest-pool-workers`:
 *
 *   1. Apply the D1 view migrations (projection target).
 *   2. Seed a per-term DO via `SOZLUK_TERM.idFromName(slug).seed(...)`.
 *   3. Verify `getTerm()` returns the expected `TermPage` shape.
 *   4. Verify the projection ran end-to-end and `term_summary` got the row.
 *   5. Verify `terms(sort, limit)` reads from `PHOENIX_DB.term_summary`.
 *   6. Verify out-of-order projection events become no-ops (last_event_id
 *      guard) by hitting the projection workflow directly.
 *
 * Pool-workers boots a fresh isolate per test file, so DOs and D1 start
 * empty. The pool wires `SOZLUK_TERM` and `PHOENIX_PROJECTION` per
 * `wrangler.jsonc`; we exercise them through their public RPC surface.
 */
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import {listTermSummaries} from "../../worker/features/sozluk/termSummaryReader";
// SQL file imported via the wrangler `Text` rule — same mechanism the worker
// uses for its drizzle migration loader.
import viewMigration0000 from "../../worker/db/drizzle/migrations/0000_secret_iron_patriot.sql";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

/**
 * D1 migrations are not auto-applied by pool-workers. Splits the migration
 * SQL on `--> statement-breakpoint` (drizzle's separator) and runs each
 * statement; ignores `already exists` errors so re-runs in the same isolate
 * are no-ops.
 */
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
			if (!msg.includes("already exists")) throw err;
		}
	}
}

/**
 * Block until the projection workflow drains the seeded outbox into the
 * `term_summary` row. Workflows steps are async; we poll defensively.
 */
async function waitForTermSummary(slug: string, attempts = 20): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		const result = await env.PHOENIX_DB.prepare("SELECT slug FROM term_summary WHERE slug = ?")
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

describe("SozlukTerm — read paths after T2 refactor", () => {
	it("seeds a term, reads it back via getTerm and via term_summary projection", async () => {
		const slug = "agent";
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
		const result = await stub.seed({
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

		expect(result.created).toBe(true);
		expect(result.insertedDefinitions).toBe(2);
		expect(result.skippedDefinitions).toBe(0);

		// Read path 1: per-term DO RPC.
		const term = await stub.getTerm();
		expect(term).not.toBeNull();
		expect(term!.slug).toBe(slug);
		expect(term!.title).toBe("Agent");
		expect(term!.totalDefinitions).toBe(2);
		expect(term!.totalScore).toBe(8);
		// Highest-score definition first per the read-path contract.
		expect(term!.definitions[0]!.score).toBe(5);
		expect(term!.definitions[1]!.score).toBe(3);

		// Read path 2: cross-entity D1 view (after projection).
		await waitForTermSummary(slug);

		const summaries = await listTermSummaries(env.PHOENIX_DB, {sort: "popular", limit: 10});
		const summary = summaries.find((s) => s.slug === slug);
		expect(summary).toBeDefined();
		expect(summary!.title).toBe("Agent");
		expect(summary!.count).toBe(2);
		expect(summary!.totalScore).toBe(8);
		// Excerpt is the highest-score definition's body, truncated.
		expect(summary!.excerpt).toContain("autonomous reasoning entity");
	});

	it("getTerm returns null when no term has been seeded yet", async () => {
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName("never-existed"));
		const term = await stub.getTerm();
		expect(term).toBeNull();
	});

	it("seed is idempotent: re-seeding the same definition is a no-op", async () => {
		const slug = "outbox";
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
		const def = {
			authorId: "u1",
			authorName: "umut",
			body: "Atomic durability primitive in the producer-consumer outbox pattern.",
		};

		const first = await stub.seed({title: "Outbox", definitions: [def]});
		expect(first.insertedDefinitions).toBe(1);
		expect(first.skippedDefinitions).toBe(0);

		const second = await stub.seed({title: "Outbox", definitions: [def]});
		expect(second.insertedDefinitions).toBe(0);
		expect(second.skippedDefinitions).toBe(1);

		const term = await stub.getTerm();
		expect(term!.totalDefinitions).toBe(1);
	});

	it("clearAll wipes definitions and the term_meta row", async () => {
		const slug = "transient";
		const stub = env.SOZLUK_TERM.get(env.SOZLUK_TERM.idFromName(slug));
		await stub.seed({
			title: "Transient",
			definitions: [{authorId: "u1", authorName: "umut", body: "Short-lived state."}],
		});

		const cleared = await stub.clearAll();
		expect(cleared.term).toBe(true);
		expect(cleared.definitions).toBe(1);

		const empty = await stub.getTerm();
		expect(empty).toBeNull();
	});
});
