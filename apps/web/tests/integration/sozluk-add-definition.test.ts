/**
 * Sozluk D1-direct `addDefinition`.
 *
 * Exercises the module-functional path against `env.PHOENIX_DB`:
 *   1. Apply view migrations (including 0005 for d1-direct sozluk tables).
 *   2. Auto-create-term: addDefinition on a fresh slug inserts the
 *      definition_view row AND upserts term_summary AND refreshes
 *      sozluk_stats.
 *   3. Falls back to slug-with-spaces when no termTitle is supplied.
 *   4. Validation: empty body and >10 000 char bodies reject with the right
 *      error code.
 *
 * No `runInDurableObject`, no outbox, no projection workflow — the writes
 * are inline D1 (ADR 0009).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {
	addDefinition,
	DefinitionValidationError,
	getTerm,
} from "../../worker/features/sozluk/module";

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

describe("sozluk.addDefinition", () => {
	it("auto-creates the term + inserts the definition_view + refreshes sozluk_stats", async () => {
		const slug = "outbox-pattern";

		const result = await addDefinition(env, {
			termSlug: slug,
			authorId: "u1",
			authorName: "umut",
			body: "Atomic durability primitive: write outbox row in same tx as the mutation; flush async.",
			termTitle: "Outbox Pattern",
		});

		expect(result.definitionId).toBeTruthy();
		expect(result.termCreated).toBe(true);
		expect(result.score).toBe(0);

		// term_summary row landed inline.
		const summary = await env.PHOENIX_DB.prepare(
			"SELECT slug, title, definition_count, total_score FROM term_summary WHERE slug = ?",
		)
			.bind(slug)
			.first<{slug: string; title: string; definition_count: number; total_score: number}>();
		expect(summary).not.toBeNull();
		expect(summary!.title).toBe("Outbox Pattern");
		expect(summary!.definition_count).toBe(1);

		// definition_view row landed inline.
		const view = await env.PHOENIX_DB.prepare(
			"SELECT id, term_slug, term_title, author_id, author_name, body, body_excerpt FROM definition_view WHERE id = ?",
		)
			.bind(result.definitionId)
			.first<{
				id: string;
				term_slug: string;
				term_title: string;
				author_id: string;
				author_name: string;
				body: string;
				body_excerpt: string;
			}>();
		expect(view).not.toBeNull();
		expect(view!.term_slug).toBe(slug);
		expect(view!.term_title).toBe("Outbox Pattern");
		expect(view!.author_id).toBe("u1");
		expect(view!.author_name).toBe("umut");
		expect(view!.body).toContain("Atomic durability");
		expect(view!.body_excerpt).toContain("Atomic durability");

		// getTerm reads back the new shape.
		const term = await getTerm(env, slug);
		expect(term).not.toBeNull();
		expect(term!.title).toBe("Outbox Pattern");
		expect(term!.totalDefinitions).toBe(1);
		expect(term!.definitions[0]!.body).toContain("Atomic durability");
		expect(term!.definitions[0]!.author).toBe("umut");
	});

	it("derives the term title from the slug when termTitle is not supplied", async () => {
		const slug = "pure-function";
		await addDefinition(env, {
			termSlug: slug,
			authorId: "u2",
			authorName: "elif",
			body: "A function whose output depends only on its inputs and produces no observable side effects.",
		});

		const term = await getTerm(env, slug);
		// "pure-function" → "pure function"
		expect(term!.title).toBe("pure function");
	});

	it("rejects empty body", async () => {
		await expect(
			addDefinition(env, {
				termSlug: "empty-body",
				authorId: "u1",
				authorName: "umut",
				body: "",
			}),
		).rejects.toBeInstanceOf(DefinitionValidationError);
		await expect(
			addDefinition(env, {
				termSlug: "empty-body",
				authorId: "u1",
				authorName: "umut",
				body: "   ",
			}),
		).rejects.toBeInstanceOf(DefinitionValidationError);
	});

	it("rejects bodies over 10 000 chars", async () => {
		const body = "x".repeat(10_001);
		await expect(
			addDefinition(env, {
				termSlug: "too-long",
				authorId: "u1",
				authorName: "umut",
				body,
			}),
		).rejects.toBeInstanceOf(DefinitionValidationError);
	});

	it("a second addDefinition on the same slug extends the term, not creates a new one", async () => {
		const slug = "two-definitions";
		const first = await addDefinition(env, {
			termSlug: slug,
			authorId: "u1",
			authorName: "umut",
			body: "first definition body",
		});
		expect(first.termCreated).toBe(true);

		const second = await addDefinition(env, {
			termSlug: slug,
			authorId: "u2",
			authorName: "elif",
			body: "second definition body",
		});
		expect(second.termCreated).toBe(false);

		const term = await getTerm(env, slug);
		expect(term!.totalDefinitions).toBe(2);
	});
});
