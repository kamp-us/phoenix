/**
 * Pano D1-direct `submitPost` (task_7, d1-direct).
 *
 * Exercises the module-functional path against `env.PHOENIX_DB`:
 *   1. Apply view migrations (including 0006 for d1-direct pano tables).
 *   2. Happy path: submitPost mints a post id, inserts `post_summary` with
 *      denormalized author + tags + host, bumps `pano_stats`.
 *   3. Validation: empty title, > 200 chars title, invalid URL,
 *      > 10 000 char body, empty tags, off-enum tag.
 *   4. Author indexing: the `post_summary` row exposes author_id and
 *      created_at so the `(author_id, created_at DESC)` index can serve
 *      the profile feed.
 *
 * No `runInDurableObject`, no outbox, no projection workflow — the writes
 * are inline D1 (ADR 0009).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import viewMigration0000 from "../../worker/db/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/db/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/db/drizzle/migrations/0002_wandering_natasha_romanoff.sql";
import viewMigration0003 from "../../worker/db/drizzle/migrations/0003_lazy_thanos.sql";
import viewMigration0004 from "../../worker/db/drizzle/migrations/0004_brown_squadron_supreme.sql";
import viewMigration0005 from "../../worker/db/drizzle/migrations/0005_d1_direct_sozluk.sql";
import viewMigration0006 from "../../worker/db/drizzle/migrations/0006_d1_direct_pano.sql";
import {PostValidationError, submitPost} from "../../worker/features/pano/module";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [
		viewMigration0000,
		viewMigration0001,
		viewMigration0002,
		viewMigration0003,
		viewMigration0004,
		viewMigration0005,
		viewMigration0006,
	];
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

async function expectRejection(promise: Promise<unknown>, match: RegExp): Promise<void> {
	try {
		await promise;
		throw new Error("expected rejection");
	} catch (err) {
		expect((err as Error).message).toMatch(match);
	}
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("pano.submitPost — task_7", () => {
	it("writes post_summary with denormalized author + tags + host", async () => {
		const result = await submitPost(env, {
			title: "phoenix neden tek worker'da koşuyor",
			url: "https://example.com/phoenix-arch",
			body: "Tek deploy, tek bind, tek SPA — DO'lar incremental şekilde geliyor.",
			tags: [
				{kind: "tartışma", label: "tartışma"},
				{kind: "meta", label: "meta"},
			],
			authorId: "u-author-1",
			authorName: "umut",
		});

		expect(result.postId).toMatch(/^post_/);
		expect(result.host).toBe("example.com");
		expect(result.url).toBe("https://example.com/phoenix-arch");
		expect(result.tags.map((t) => t.kind)).toEqual(["tartışma", "meta"]);
		expect(result.score).toBe(0);
		expect(result.commentCount).toBe(0);

		const summary = (await env.PHOENIX_DB.prepare(
			"SELECT id, title, url, host, body, body_excerpt, author_id, author_name, tags, score, comment_count FROM post_summary WHERE id = ?",
		)
			.bind(result.postId)
			.first()) as {
			id: string;
			title: string;
			url: string;
			host: string;
			body: string;
			body_excerpt: string;
			author_id: string;
			author_name: string;
			tags: string;
			score: number;
			comment_count: number;
		} | null;

		expect(summary).not.toBeNull();
		expect(summary!.title).toContain("phoenix");
		expect(summary!.host).toBe("example.com");
		expect(summary!.url).toBe("https://example.com/phoenix-arch");
		expect(summary!.author_id).toBe("u-author-1");
		expect(summary!.author_name).toBe("umut");
		// Tags are stored as comma-separated kind values (Turkish enum).
		expect(summary!.tags).toBe("tartışma,meta");
		expect(summary!.score).toBe(0);
		expect(summary!.comment_count).toBe(0);
		expect(summary!.body).toContain("Tek deploy");
		expect(summary!.body_excerpt).toContain("Tek deploy");
	});

	it("rejects empty title", async () => {
		await expectRejection(
			submitPost(env, {
				title: "   ",
				tags: [{kind: "tartışma"}],
				authorId: "u1",
				authorName: "umut",
			}),
			/boş olamaz|gerekli/i,
		);
	});

	it("rejects titles over 200 chars", async () => {
		await expectRejection(
			submitPost(env, {
				title: "x".repeat(201),
				tags: [{kind: "tartışma"}],
				authorId: "u1",
				authorName: "umut",
			}),
			/200|en fazla/i,
		);
	});

	it("rejects invalid URLs", async () => {
		await expectRejection(
			submitPost(env, {
				title: "valid title",
				url: "not a url",
				tags: [{kind: "tartışma"}],
				authorId: "u1",
				authorName: "umut",
			}),
			/url|geçersiz/i,
		);
	});

	it("rejects bodies over 10 000 chars", async () => {
		await expectRejection(
			submitPost(env, {
				title: "valid title",
				body: "x".repeat(10_001),
				tags: [{kind: "tartışma"}],
				authorId: "u1",
				authorName: "umut",
			}),
			/10\s?000|en fazla/i,
		);
	});

	it("rejects empty tag list", async () => {
		await expectRejection(
			submitPost(env, {
				title: "valid title",
				tags: [],
				authorId: "u1",
				authorName: "umut",
			}),
			/etiket|en az/i,
		);
	});

	it("rejects tags outside the fixed enum", async () => {
		await expectRejection(
			submitPost(env, {
				title: "valid title",
				tags: [{kind: "haber"}],
				authorId: "u1",
				authorName: "umut",
			}),
			/geçersiz|invalid/i,
		);
	});

	it("validation errors carry a typed code via PostValidationError", async () => {
		try {
			await submitPost(env, {
				title: "",
				tags: [{kind: "tartışma"}],
				authorId: "u1",
				authorName: "umut",
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect(err).toBeInstanceOf(PostValidationError);
			expect((err as PostValidationError).code).toBe("title_required");
		}
	});

	it("post_summary carries author_id + created_at so the (author_id, created_at DESC) index can serve the profile feed", async () => {
		// Author submits two posts in sequence; verify both rows land with the
		// same author_id and that ordering by created_at DESC returns the
		// newest first.
		const authorId = `u-idx-${Date.now().toString(36)}`;

		const first = await submitPost(env, {
			title: "first post",
			tags: [{kind: "meta"}],
			authorId,
			authorName: "indexer",
		});

		// Force a 1100ms gap so created_at sec-resolution doesn't collapse the
		// two rows onto the same timestamp.
		await new Promise((r) => setTimeout(r, 1100));

		const second = await submitPost(env, {
			title: "second post",
			tags: [{kind: "meta"}],
			authorId,
			authorName: "indexer",
		});

		const rows = await env.PHOENIX_DB.prepare(
			"SELECT id, title FROM post_summary WHERE author_id = ? ORDER BY created_at DESC",
		)
			.bind(authorId)
			.all();
		expect(rows.results.length).toBe(2);
		expect(rows.results[0]!.id).toBe(second.postId);
		expect(rows.results[1]!.id).toBe(first.postId);
	});
});
