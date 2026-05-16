/**
 * PanoPost.submitPost + outbox + PostChanged projection — task_7.
 *
 * Mirrors `sozluk-add-definition.test.ts`. Exercises the producer pattern (ADR
 * 0007) end-to-end inside workerd:
 *   1. Apply view migrations.
 *   2. Happy path: submitPost on a fresh DO writes post_meta + tags + outbox
 *      atomically; flushOutbox dispatches; post_summary projection lands with
 *      the denormalized author + tags + host.
 *   3. Validation: empty title, > 200 chars title, invalid URL, > 10 000 char
 *      body, empty tags, off-enum tag.
 *   4. Reconciliation: workflow.create stubbed to throw on first attempt →
 *      outbox row remains → reconcileOutbox re-queues and clears it.
 *   5. Author indexing: the projected post_summary row exposes author_id and
 *      created_at so the `(author_id, created_at DESC)` index can serve the
 *      profile feed.
 */
import {env, runInDurableObject} from "cloudflare:test";
import {id} from "@usirin/forge";
import {beforeAll, describe, expect, it} from "vitest";
import viewMigration0000 from "../../worker/db/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/db/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/db/drizzle/migrations/0002_wandering_natasha_romanoff.sql";
import viewMigration0003 from "../../worker/db/drizzle/migrations/0003_lazy_thanos.sql";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [viewMigration0000, viewMigration0001, viewMigration0002, viewMigration0003];
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

async function waitForRow(sql: string, params: unknown[], attempts = 30): Promise<unknown> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(sql)
			.bind(...params)
			.first();
		if (row) return row;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
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

describe("PanoPost.submitPost — task_7", () => {
	it("writes post_meta + tags + outbox + post_summary projection with denormalized author + tags + host", async () => {
		const postId = id("post");
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));

		const result = await stub.submitPost({
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

		expect(result.postId).toBe(postId);
		expect(result.host).toBe("example.com");
		expect(result.url).toBe("https://example.com/phoenix-arch");
		expect(result.tags.map((t) => t.kind)).toEqual(["tartışma", "meta"]);

		const post = await stub.getPost();
		expect(post).not.toBeNull();
		expect(post!.id).toBe(postId);
		expect(post!.title).toContain("phoenix");
		expect(post!.host).toBe("example.com");
		expect(post!.author).toBe("umut");
		expect(post!.tags).toHaveLength(2);

		const summary = (await waitForRow(
			"SELECT id, title, url, host, author_id, author_name, tags, score, comment_count FROM post_summary WHERE id = ?",
			[postId],
		)) as {
			id: string;
			title: string;
			url: string;
			host: string;
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
	});

	it("rejects empty title", async () => {
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(id("post")));
		await expectRejection(
			stub.submitPost({
				title: "   ",
				tags: [{kind: "tartışma"}],
				authorId: "u1",
				authorName: "umut",
			}),
			/boş olamaz|gerekli/i,
		);
	});

	it("rejects titles over 200 chars", async () => {
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(id("post")));
		await expectRejection(
			stub.submitPost({
				title: "x".repeat(201),
				tags: [{kind: "tartışma"}],
				authorId: "u1",
				authorName: "umut",
			}),
			/200|en fazla/i,
		);
	});

	it("rejects invalid URLs", async () => {
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(id("post")));
		await expectRejection(
			stub.submitPost({
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
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(id("post")));
		await expectRejection(
			stub.submitPost({
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
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(id("post")));
		await expectRejection(
			stub.submitPost({
				title: "valid title",
				tags: [],
				authorId: "u1",
				authorName: "umut",
			}),
			/etiket|en az/i,
		);
	});

	it("rejects tags outside the fixed enum", async () => {
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(id("post")));
		await expectRejection(
			stub.submitPost({
				title: "valid title",
				tags: [{kind: "haber"}],
				authorId: "u1",
				authorName: "umut",
			}),
			/geçersiz|invalid/i,
		);
	});

	it("flushOutbox clears the outbox row on success", async () => {
		const postId = id("post");
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
		await stub.submitPost({
			title: "outbox flush check",
			tags: [{kind: "meta"}],
			authorId: "u1",
			authorName: "umut",
		});

		const remaining = await runInDurableObject(stub, async (instance: any) => {
			return instance.sql<{n: number}>`SELECT COUNT(*) as n FROM outbox`;
		});
		expect(remaining[0]!.n).toBe(0);
	});

	it("workflow.create failure leaves outbox row; reconcileOutbox re-queues and clears it", async () => {
		const postId = id("post");
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));

		const result = await runInDurableObject(stub, async (instance: any) => {
			const original = instance.env.PHOENIX_PROJECTION.create.bind(
				instance.env.PHOENIX_PROJECTION,
			);
			let calls = 0;
			instance.env.PHOENIX_PROJECTION = {
				...instance.env.PHOENIX_PROJECTION,
				create: async (params: unknown) => {
					calls++;
					if (calls === 1) throw new Error("simulated workflow create failure");
					return original(params);
				},
			};

			try {
				await instance.submitPost({
					title: "reconcile path",
					tags: [{kind: "meta"}],
					authorId: "u9",
					authorName: "test",
				});
			} catch {
				/* swallow */
			}

			const before = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;
			expect(before.length).toBe(1);

			await instance.reconcileOutbox();

			const after = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;
			return {beforeCount: before.length, afterCount: after.length};
		});

		expect(result.beforeCount).toBe(1);
		expect(result.afterCount).toBe(0);
	});

	it("post_summary carries author_id + created_at so the (author_id, created_at DESC) index can serve the profile feed", async () => {
		// Author submits two posts in sequence; verify both rows land with the
		// same author_id and that ordering by created_at DESC returns the
		// newest first.
		const authorId = `u-${id("user")}`;
		const firstId = id("post");
		const secondId = id("post");

		const first = env.PANO_POST.get(env.PANO_POST.idFromName(firstId));
		await first.submitPost({
			title: "first post",
			tags: [{kind: "meta"}],
			authorId,
			authorName: "indexer",
		});

		// Force a 1ms gap so created_at sec-resolution doesn't collapse the two
		// rows onto the same timestamp (then sort by id falls back to PK).
		await new Promise((r) => setTimeout(r, 1100));

		const second = env.PANO_POST.get(env.PANO_POST.idFromName(secondId));
		await second.submitPost({
			title: "second post",
			tags: [{kind: "meta"}],
			authorId,
			authorName: "indexer",
		});

		await waitForRow("SELECT id FROM post_summary WHERE id = ?", [firstId]);
		await waitForRow("SELECT id FROM post_summary WHERE id = ?", [secondId]);

		const rows = await env.PHOENIX_DB.prepare(
			"SELECT id, title FROM post_summary WHERE author_id = ? ORDER BY created_at DESC",
		)
			.bind(authorId)
			.all();
		expect(rows.results.length).toBe(2);
		expect(rows.results[0]!.id).toBe(secondId);
		expect(rows.results[1]!.id).toBe(firstId);
	});
});
