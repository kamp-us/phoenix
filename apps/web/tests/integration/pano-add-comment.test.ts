/**
 * PanoPost.addComment + CommentAdded projection — task_10.
 *
 * Mirrors the addDefinition / submitPost integration suites. Exercises the
 * producer pattern (ADR 0007) for comments end-to-end inside workerd:
 *   1. Apply view migrations.
 *   2. Seed a post via `submitPost` (T7 path; lands the `post_summary` row).
 *   3. Top-level comment → comment row + post_meta.comment_count bumped +
 *      outbox emits CommentAdded AND PostChanged → `comment_view` MV row
 *      with denormalized columns + `post_summary.comment_count` reflects the
 *      bump after projection.
 *   4. Nested comment with a valid parent succeeds; reply lands with
 *      `parent_id` referencing the parent.
 *   5. Nested comment with an unknown / missing parent rejects with a typed
 *      `CommentValidationError` (`parent_not_found`).
 *   6. Validation: empty body / whitespace-only / body > 5 000 chars all
 *      reject.
 *   7. Outbox durability: a comment whose first workflow.create attempt fails
 *      leaves the outbox row; `reconcileOutbox` re-queues and clears.
 */
import {id} from "@usirin/forge";
import {env, runInDurableObject} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import viewMigration0000 from "../../worker/view/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/view/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/view/drizzle/migrations/0002_wandering_natasha_romanoff.sql";
import viewMigration0003 from "../../worker/view/drizzle/migrations/0003_lazy_thanos.sql";

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
	sql: string,
	params: unknown[],
	predicate: (row: unknown | null) => boolean,
	attempts = 30,
): Promise<unknown> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(sql)
			.bind(...params)
			.first();
		if (predicate(row)) return row;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function seedPost(opts: {
	authorId: string;
	authorName?: string;
	title?: string;
}) {
	const postId = id("post");
	const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
	await stub.submitPost({
		title: opts.title ?? "comment test başlık",
		body: "comment test body",
		tags: [{kind: "tartışma"}],
		authorId: opts.authorId,
		authorName: opts.authorName ?? "post author",
	});
	await waitForRow<{id: string}>("SELECT id FROM post_summary WHERE id = ?", [postId]);
	return {stub, postId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("PanoPost.addComment — task_10", () => {
	it("inserts top-level comment + bumps post.commentCount + writes comment_view + bumps post_summary.commentCount", async () => {
		const {stub, postId} = await seedPost({authorId: "p-author-1"});

		const result = await stub.addComment({
			authorId: "c-author-1",
			authorName: "commenter",
			body: "first top-level comment on the post.",
		});

		expect(result.commentId).toMatch(/^comm_/);
		expect(result.parentId).toBeNull();
		expect(result.authorName).toBe("commenter");
		expect(result.body).toContain("first top-level comment");

		// In-DO: post_meta.comment_count bumped to 1; comment row exists.
		const post = await stub.getPost();
		expect(post!.commentCount).toBe(1);
		const comments = await stub.listComments();
		expect(comments).toHaveLength(1);
		expect(comments[0]!.id).toBe(result.commentId);
		expect(comments[0]!.parentId).toBeNull();

		// MV: comment_view row landed with denormalized columns.
		const view = (await waitForRow(
			"SELECT id, author_id, author_name, post_id, post_title, body_excerpt, score, deleted_at FROM comment_view WHERE id = ?",
			[result.commentId],
		)) as {
			id: string;
			author_id: string;
			author_name: string;
			post_id: string;
			post_title: string;
			body_excerpt: string;
			score: number;
			deleted_at: number | null;
		} | null;
		expect(view).not.toBeNull();
		expect(view!.author_id).toBe("c-author-1");
		expect(view!.author_name).toBe("commenter");
		expect(view!.post_id).toBe(postId);
		expect(view!.post_title).toContain("comment test başlık");
		expect(view!.body_excerpt).toContain("first top-level comment");
		expect(view!.score).toBe(0);
		expect(view!.deleted_at).toBeNull();

		// post_summary.comment_count converged via the PostChanged event.
		const summary = await waitForCondition(
			"SELECT comment_count FROM post_summary WHERE id = ?",
			[postId],
			(r) => r != null && (r as {comment_count: number}).comment_count === 1,
		);
		expect(summary).not.toBeNull();
	});

	it("accepts a nested reply with a valid parent_id", async () => {
		const {stub, postId} = await seedPost({authorId: "p-author-2"});

		const parent = await stub.addComment({
			authorId: "c-parent",
			authorName: "parent author",
			body: "parent comment",
		});

		const reply = await stub.addComment({
			authorId: "c-reply",
			authorName: "reply author",
			body: "nested reply",
			parentId: parent.commentId,
		});

		expect(reply.parentId).toBe(parent.commentId);

		const post = await stub.getPost();
		expect(post!.commentCount).toBe(2);

		const comments = await stub.listComments();
		expect(comments).toHaveLength(2);
		const reloaded = comments.find((c) => c.id === reply.commentId);
		expect(reloaded!.parentId).toBe(parent.commentId);

		// Both comment_view rows exist.
		await waitForRow("SELECT id FROM comment_view WHERE id = ?", [parent.commentId]);
		await waitForRow("SELECT id FROM comment_view WHERE id = ?", [reply.commentId]);

		// post_summary.comment_count converged to 2.
		await waitForCondition(
			"SELECT comment_count FROM post_summary WHERE id = ?",
			[postId],
			(r) => r != null && (r as {comment_count: number}).comment_count === 2,
		);
	});

	it("rejects a nested reply when parent_id references a missing comment", async () => {
		const {stub} = await seedPost({authorId: "p-author-3"});

		try {
			await stub.addComment({
				authorId: "c-orphan",
				authorName: "orphan",
				body: "reply to nothing",
				parentId: "comm_does_not_exist",
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("CommentValidationError");
			expect(((err as Error) as Error & {code?: string}).code).toBe("parent_not_found");
		}

		// No row landed.
		const post = await stub.getPost();
		expect(post!.commentCount).toBe(0);
	});

	it("rejects empty / whitespace-only body", async () => {
		const {stub} = await seedPost({authorId: "p-author-4"});

		for (const body of ["", "    ", "\n\n\t"]) {
			try {
				await stub.addComment({
					authorId: "c1",
					authorName: "c",
					body,
				});
				throw new Error(`expected rejection for body=${JSON.stringify(body)}`);
			} catch (err) {
				expect((err as Error).name).toBe("CommentValidationError");
				expect(((err as Error) as Error & {code?: string}).code).toBe("body_required");
			}
		}
	});

	it("rejects bodies over 5 000 chars", async () => {
		const {stub} = await seedPost({authorId: "p-author-5"});

		try {
			await stub.addComment({
				authorId: "c1",
				authorName: "c",
				body: "x".repeat(5_001),
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("CommentValidationError");
			expect(((err as Error) as Error & {code?: string}).code).toBe("body_too_long");
		}
	});

	it("outbox: workflow.create failure leaves outbox rows; reconcileOutbox re-queues and clears", async () => {
		const {stub} = await seedPost({authorId: "p-author-6"});

		const counts = await runInDurableObject(stub, async (instance: any) => {
			const original = instance.env.PHOENIX_PROJECTION.create.bind(
				instance.env.PHOENIX_PROJECTION,
			);
			let calls = 0;
			instance.env.PHOENIX_PROJECTION = {
				...instance.env.PHOENIX_PROJECTION,
				create: async (params: unknown) => {
					calls++;
					// Fail both inline flush attempts on the first comment so both
					// outbox rows (CommentAdded + PostChanged) get stuck.
					if (calls <= 2) throw new Error("simulated workflow create failure");
					return original(params);
				},
			};

			try {
				await instance.addComment({
					authorId: "c-recon",
					authorName: "recon",
					body: "stuck on first call",
				});
			} catch {
				/* swallow */
			}

			const before = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;
			await instance.reconcileOutbox();
			const after = instance.sql<{event_id: string}>`SELECT event_id FROM outbox`;
			return {beforeCount: before.length, afterCount: after.length};
		});

		expect(counts.beforeCount).toBe(2);
		expect(counts.afterCount).toBe(0);
	});
});
