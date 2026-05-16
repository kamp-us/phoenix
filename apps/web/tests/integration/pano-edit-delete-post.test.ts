/**
 * PanoPost.editPost / deletePost + PostChanged / PostDeleted projection —
 * task_9.
 *
 * Mirrors `sozluk-edit-delete-definition.test.ts` (T6). Exercises the producer
 * pattern (ADR 0007) end-to-end inside workerd:
 *   1. Apply view migrations.
 *   2. Seed a post via `submitPost` (T7 path); wait for the `post_summary`
 *      projection.
 *   3. Edit the title / body → `post_meta` reflects the new values; the
 *      `post_summary` row converges via the existing `PostChanged` step.
 *   4. Ownership: a non-author actor's edit / delete throws
 *      `UnauthorizedPostMutationError`.
 *   5. Delete → stamps `deleted_at` on `post_meta` (so `getPost` returns null);
 *      the `PostDeleted` projection REMOVES the row from `post_summary`
 *      entirely (vs. soft-stamping for definitions).
 *   6. Idempotent re-delete on an already-deleted row is a no-op.
 *   7. Outbox durability: an edit / delete whose `workflow.create` fails
 *      leaves the outbox row; `reconcileOutbox` re-queues and clears it.
 */
import {id} from "@usirin/forge";
import {env, runInDurableObject} from "cloudflare:test";
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

async function waitForRow<T>(sql: string, params: unknown[], attempts = 30): Promise<T | null> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(sql)
			.bind(...params)
			.first();
		if (row) return row as T;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function waitForCondition(
	sqlStr: string,
	params: unknown[],
	predicate: (row: unknown | null) => boolean,
	attempts = 30,
): Promise<unknown | null> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(sqlStr)
			.bind(...params)
			.first();
		if (predicate(row)) return row;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function seedPost(opts: {authorId: string; authorName?: string; title?: string; body?: string}) {
	const postId = id("post");
	const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
	await stub.submitPost({
		title: opts.title ?? "original title",
		body: opts.body ?? "original body",
		tags: [{kind: "tartışma"}],
		authorId: opts.authorId,
		authorName: opts.authorName ?? "umut",
	});
	await waitForRow<{id: string}>("SELECT id FROM post_summary WHERE id = ?", [postId]);
	return {stub, postId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("PanoPost.editPost — task_9", () => {
	it("updates title + body and projects PostChanged onto post_summary", async () => {
		const authorId = "edit-post-author";
		const {stub, postId} = await seedPost({authorId});

		const before = (await waitForRow<{title: string; body_excerpt: string}>(
			"SELECT title, body_excerpt FROM post_summary WHERE id = ?",
			[postId],
		))!;
		expect(before.title).toBe("original title");

		const result = await stub.editPost({
			actorId: authorId,
			title: "edited title — fresh",
			body: "edited body — significantly different content here.",
		});
		expect(result.title).toBe("edited title — fresh");
		expect(result.body).toContain("edited body");

		const post = await stub.getPost();
		expect(post!.title).toBe("edited title — fresh");
		expect(post!.body).toContain("edited body");

		const after = (await waitForCondition(
			"SELECT title, body_excerpt FROM post_summary WHERE id = ?",
			[postId],
			(r) => (r as {title: string} | null)?.title === "edited title — fresh",
		)) as {title: string; body_excerpt: string};
		expect(after).not.toBeNull();
		expect(after.body_excerpt).toContain("edited body");
	});

	it("allows editing title alone", async () => {
		const authorId = "edit-title-only";
		const {stub, postId} = await seedPost({authorId});

		await stub.editPost({actorId: authorId, title: "title-only edit"});
		const post = await stub.getPost();
		expect(post!.title).toBe("title-only edit");
		expect(post!.body).toBe("original body");

		await waitForCondition(
			"SELECT title FROM post_summary WHERE id = ?",
			[postId],
			(r) => (r as {title: string} | null)?.title === "title-only edit",
		);
	});

	it("allows editing body alone", async () => {
		const authorId = "edit-body-only";
		const {stub} = await seedPost({authorId});

		await stub.editPost({actorId: authorId, body: "body-only edit"});
		const post = await stub.getPost();
		expect(post!.title).toBe("original title");
		expect(post!.body).toBe("body-only edit");
	});

	it("rejects when neither title nor body provided", async () => {
		const authorId = "edit-empty";
		const {stub} = await seedPost({authorId});

		try {
			await stub.editPost({actorId: authorId});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("PostValidationError");
		}
	});

	it("rejects empty title (trim)", async () => {
		const authorId = "edit-blank-title";
		const {stub} = await seedPost({authorId});

		try {
			await stub.editPost({actorId: authorId, title: "   "});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).message).toMatch(/boş olamaz|gerekli/i);
		}
	});

	it("rejects titles over 200 chars", async () => {
		const authorId = "edit-title-long";
		const {stub} = await seedPost({authorId});

		try {
			await stub.editPost({actorId: authorId, title: "x".repeat(201)});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).message).toMatch(/200|en fazla/i);
		}
	});

	it("rejects bodies over 10 000 chars", async () => {
		const authorId = "edit-body-long";
		const {stub} = await seedPost({authorId});

		try {
			await stub.editPost({actorId: authorId, body: "x".repeat(10_001)});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).message).toMatch(/10\s?000|en fazla/i);
		}
	});

	it("ownership: non-author edit is rejected with UnauthorizedPostMutationError", async () => {
		const authorId = "owner-post";
		const otherId = "intruder-post";
		const {stub} = await seedPost({authorId, title: "owner's title"});

		try {
			await stub.editPost({
				actorId: otherId,
				title: "intruder's title rewrite",
			});
			throw new Error("expected rejection");
		} catch (err) {
			// Name preserved across the RPC boundary (the class identity is not —
			// `instanceof` doesn't survive workerd's RPC marshaling).
			expect((err as Error).name).toBe("UnauthorizedPostMutationError");
			expect((err as Error).message).toMatch(/not authorized/i);
		}

		// The post did NOT change.
		const post = await stub.getPost();
		expect(post!.title).toBe("owner's title");
	});
});

describe("PanoPost.deletePost — task_9", () => {
	it("stamps deleted_at; getPost returns null; PostDeleted projection REMOVES the row from post_summary", async () => {
		const authorId = "delete-post-author";
		const {stub, postId} = await seedPost({authorId});

		// Sanity: post_summary has the row pre-delete.
		const before = await waitForRow<{id: string}>(
			"SELECT id FROM post_summary WHERE id = ?",
			[postId],
		);
		expect(before).not.toBeNull();

		const result = await stub.deletePost({actorId: authorId});
		expect(result.deleted).toBe(true);

		// getPost returns null after delete.
		const post = await stub.getPost();
		expect(post).toBeNull();

		// post_summary row is fully removed by the PostDeleted projection.
		const after = await waitForCondition(
			"SELECT id FROM post_summary WHERE id = ?",
			[postId],
			(r) => r === null,
		);
		expect(after).toBeNull();
	});

	it("ownership: non-author delete is rejected with UnauthorizedPostMutationError", async () => {
		const authorId = "owner-del";
		const otherId = "intruder-del";
		const {stub, postId} = await seedPost({authorId});

		try {
			await stub.deletePost({actorId: otherId});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("UnauthorizedPostMutationError");
		}

		// The post is still there.
		const post = await stub.getPost();
		expect(post).not.toBeNull();
		// post_summary row still present.
		const row = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
			.bind(postId)
			.first();
		expect(row).not.toBeNull();
	});

	it("re-deleting an already-deleted post is an idempotent no-op", async () => {
		const authorId = "delete-idem";
		const {stub} = await seedPost({authorId});

		await stub.deletePost({actorId: authorId});
		const second = await stub.deletePost({actorId: authorId});
		expect(second.deleted).toBe(false);
	});

	it("decrements pano_stats.total_posts on delete", async () => {
		const authorId = "delete-stats";
		const {stub, postId} = await seedPost({authorId});

		// Wait for stats to include this post.
		const beforeStats = (await waitForCondition(
			"SELECT total_posts FROM pano_stats WHERE id = 1",
			[],
			(r) => r != null && (r as {total_posts: number}).total_posts >= 1,
		)) as {total_posts: number};
		const beforeCount = beforeStats.total_posts;

		await stub.deletePost({actorId: authorId});

		// Wait for stats delta.
		const afterStats = (await waitForCondition(
			"SELECT total_posts FROM pano_stats WHERE id = 1",
			[],
			(r) => r != null && (r as {total_posts: number}).total_posts === beforeCount - 1,
		)) as {total_posts: number} | null;
		expect(afterStats).not.toBeNull();
		expect(afterStats!.total_posts).toBe(beforeCount - 1);
		// Sanity: post_summary row gone.
		const row = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
			.bind(postId)
			.first();
		expect(row).toBeNull();
	});

	it("outbox: workflow.create failure leaves edit outbox row; reconcileOutbox re-queues and clears", async () => {
		const authorId = "edit-reconcile-post";
		const {stub} = await seedPost({authorId});

		const counts = await runInDurableObject(stub, async (instance: any) => {
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
				await instance.editPost({
					actorId: authorId,
					title: "edited under failure",
				});
			} catch {
				/* swallow */
			}

			const before = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;
			await instance.reconcileOutbox();
			const after = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;
			return {beforeCount: before.length, afterCount: after.length};
		});

		expect(counts.beforeCount).toBe(1);
		expect(counts.afterCount).toBe(0);
	});
});
