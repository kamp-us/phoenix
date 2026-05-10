/**
 * PanoPost + projection integration test.
 *
 * Mirrors `sozluk-term.test.ts` for the post side: seed a per-post DO via
 * `PANO_POST.idFromName(postId).seed(...)`, verify both read paths return the
 * expected shapes, and confirm the projection lands the row in `post_summary`.
 */

import {env} from "cloudflare:test";
import {id} from "@usirin/forge";
import {beforeAll, describe, expect, it} from "vitest";
import {listPostSummaries} from "../../worker/features/pano/postSummaryReader";
import viewMigration0000 from "../../worker/view/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/view/drizzle/migrations/0001_free_salo.sql";

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
	const sources = [viewMigration0000, viewMigration0001];
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
				if (!msg.includes("already exists") && !msg.includes("duplicate column")) throw err;
			}
		}
	}
}

/**
 * Block until the projection workflow drains the seeded outbox into the
 * `post_summary` row. Workflows steps are async; we poll defensively.
 */
async function waitForPostSummary(postId: string, attempts = 20): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		const result = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
			.bind(postId)
			.first();
		if (result) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`post_summary row for ${postId} never landed`);
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("PanoPost — read paths after T3 refactor", () => {
	it("seeds a post, reads it back via getPost/listComments and via post_summary projection", async () => {
		const postId = id("post");
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
		const result = await stub.seed({
			title: "phoenix nasıl tek worker'da çalışıyor",
			url: "https://example.com/phoenix",
			authorId: "u1",
			authorName: "umut",
			score: 12,
			tags: [{kind: "show", label: "göster"}],
			comments: [
				{authorId: "u2", authorName: "elif", body: "tek worker, tek deploy. çok temiz.", score: 5},
				{
					authorId: "u3",
					authorName: "arda",
					body: "DO başına bir post — coordination atom net.",
					score: 3,
					parentIdx: 0,
				},
			],
		});

		expect(result.created).toBe(true);
		expect(result.insertedComments).toBe(2);
		expect(result.insertedTags).toBe(1);

		// Read path 1: per-post DO RPC.
		const post = await stub.getPost();
		expect(post).not.toBeNull();
		expect(post!.id).toBe(postId);
		expect(post!.title).toContain("phoenix");
		expect(post!.url).toBe("https://example.com/phoenix");
		expect(post!.host).toBe("example.com");
		expect(post!.author).toBe("umut");
		expect(post!.score).toBe(12);
		expect(post!.commentCount).toBe(2);
		expect(post!.tags).toHaveLength(1);
		expect(post!.tags[0]).toEqual({kind: "show", label: "göster"});

		const comments = await stub.listComments();
		expect(comments).toHaveLength(2);
		// Ordered by score desc.
		expect(comments[0]!.score).toBe(5);
		expect(comments[1]!.score).toBe(3);

		// Read path 2: cross-entity D1 view (after projection).
		await waitForPostSummary(postId);

		const summaries = await listPostSummaries(env.PHOENIX_DB, {sort: "new", limit: 10});
		const summary = summaries.find((s) => s.id === postId);
		expect(summary).toBeDefined();
		expect(summary!.title).toContain("phoenix");
		expect(summary!.url).toBe("https://example.com/phoenix");
		expect(summary!.host).toBe("example.com");
		expect(summary!.score).toBe(12);
		expect(summary!.commentCount).toBe(2);
		expect(summary!.tags).toHaveLength(1);
		expect(summary!.tags[0]!.kind).toBe("show");
	});

	it("getPost returns null when no post has been seeded yet", async () => {
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName("post_never_existed"));
		const post = await stub.getPost();
		expect(post).toBeNull();
	});

	it("seed is idempotent: re-seeding the same post is a no-op", async () => {
		const postId = id("post");
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
		const input = {
			title: "idempotency check",
			authorId: "u1",
			authorName: "umut",
			score: 1,
			tags: [],
			comments: [],
		};

		const first = await stub.seed(input);
		expect(first.created).toBe(true);

		const second = await stub.seed(input);
		expect(second.created).toBe(false);
		expect(second.insertedComments).toBe(0);
	});

	it("clearAll wipes comments, tags, and the post_meta row", async () => {
		const postId = id("post");
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
		await stub.seed({
			title: "transient",
			authorId: "u1",
			authorName: "umut",
			score: 0,
			tags: [{kind: "meta", label: "meta"}],
			comments: [{authorId: "u2", authorName: "elif", body: "ok"}],
		});

		const cleared = await stub.clearAll();
		expect(cleared.post).toBe(true);
		expect(cleared.comments).toBe(1);
		expect(cleared.tags).toBe(1);

		const empty = await stub.getPost();
		expect(empty).toBeNull();
	});

	it("host filter on listPostSummaries narrows to the requested host", async () => {
		const idA = id("post");
		const idB = id("post");
		await env.PANO_POST.get(env.PANO_POST.idFromName(idA)).seed({
			title: "github post",
			url: "https://github.com/foo/bar",
			authorId: "u1",
			authorName: "umut",
			score: 7,
			tags: [],
			comments: [],
		});
		await env.PANO_POST.get(env.PANO_POST.idFromName(idB)).seed({
			title: "elsewhere post",
			url: "https://example.com/x",
			authorId: "u1",
			authorName: "umut",
			score: 7,
			tags: [],
			comments: [],
		});

		await waitForPostSummary(idA);
		await waitForPostSummary(idB);

		const filtered = await listPostSummaries(env.PHOENIX_DB, {host: "github.com", limit: 50});
		const ids = filtered.map((p) => p.id);
		expect(ids).toContain(idA);
		expect(ids).not.toContain(idB);
	});
});
