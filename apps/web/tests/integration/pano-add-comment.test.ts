/**
 * `addComment` on D1-direct.
 *
 * Exercises the D1-direct `addComment` module surface end-to-end inside
 * workerd:
 *   1. Apply view migrations.
 *   2. Seed a post via `submitPost` (the D1-direct path).
 *   3. Top-level comment → row inserted into `comment_view` with
 *      denormalized columns + `post_summary.comment_count` bumped +
 *      `pano_stats` updated.
 *   4. Nested comment with a valid parent succeeds; reply lands with
 *      `parent_id` referencing the parent.
 *   5. Nested comment with an unknown / missing parent rejects with a
 *      typed `CommentValidationError` (`parent_not_found`).
 *   6. Validation: empty body / whitespace-only / body > 5 000 chars all
 *      reject.
 *   7. `PostNotFoundError` when the target post id doesn't exist.
 *
 * Zero `runInDurableObject` blocks — the module writes D1 directly.
 */
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {addComment, submitPost} from "../../worker/features/pano/module";

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

async function seedPost(opts: {
	authorId: string;
	authorName?: string;
	title?: string;
}) {
	const r = await submitPost(env, {
		title: opts.title ?? "comment test başlık",
		body: "comment test body",
		tags: [{kind: "tartışma"}],
		authorId: opts.authorId,
		authorName: opts.authorName ?? "post author",
	});
	return r.postId;
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("pano/module addComment", () => {
	it("inserts a top-level comment + bumps post.commentCount + writes comment_view row", async () => {
		const postId = await seedPost({authorId: "p-author-1"});

		const result = await addComment(env, {
			postId,
			authorId: "c-author-1",
			authorName: "commenter",
			body: "first top-level comment on the post.",
		});

		expect(result.commentId).toMatch(/^comm_/);
		expect(result.parentId).toBeNull();
		expect(result.authorName).toBe("commenter");
		expect(result.body).toContain("first top-level comment");
		expect(result.commentCount).toBe(1);

		// comment_view row landed with full denormalized columns.
		const view = await env.PHOENIX_DB.prepare(
			"SELECT id, author_id, author_name, post_id, post_title, body, body_excerpt, score, parent_id, deleted_at FROM comment_view WHERE id = ?",
		)
			.bind(result.commentId)
			.first<{
				id: string;
				author_id: string;
				author_name: string;
				post_id: string;
				post_title: string;
				body: string;
				body_excerpt: string;
				score: number;
				parent_id: string | null;
				deleted_at: number | null;
			}>();
		expect(view).not.toBeNull();
		expect(view!.author_id).toBe("c-author-1");
		expect(view!.author_name).toBe("commenter");
		expect(view!.post_id).toBe(postId);
		expect(view!.post_title).toContain("comment test başlık");
		expect(view!.body).toContain("first top-level comment");
		expect(view!.body_excerpt).toContain("first top-level comment");
		expect(view!.score).toBe(0);
		expect(view!.parent_id).toBeNull();
		expect(view!.deleted_at).toBeNull();

		// post_summary.comment_count incremented inline.
		const summary = await env.PHOENIX_DB.prepare(
			"SELECT comment_count FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{comment_count: number}>();
		expect(summary!.comment_count).toBe(1);
	});

	it("accepts a nested reply with a valid parent_id", async () => {
		const postId = await seedPost({authorId: "p-author-2"});

		const parent = await addComment(env, {
			postId,
			authorId: "c-parent",
			authorName: "parent author",
			body: "parent comment",
		});

		const reply = await addComment(env, {
			postId,
			authorId: "c-reply",
			authorName: "reply author",
			body: "nested reply",
			parentId: parent.commentId,
		});

		expect(reply.parentId).toBe(parent.commentId);
		expect(reply.commentCount).toBe(2);

		const replyView = await env.PHOENIX_DB.prepare(
			"SELECT parent_id FROM comment_view WHERE id = ?",
		)
			.bind(reply.commentId)
			.first<{parent_id: string}>();
		expect(replyView!.parent_id).toBe(parent.commentId);

		const summary = await env.PHOENIX_DB.prepare(
			"SELECT comment_count FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{comment_count: number}>();
		expect(summary!.comment_count).toBe(2);
	});

	it("rejects a nested reply when parent_id references a missing comment", async () => {
		const postId = await seedPost({authorId: "p-author-3"});

		try {
			await addComment(env, {
				postId,
				authorId: "c-orphan",
				authorName: "orphan",
				body: "reply to nothing",
				parentId: "comm_does_not_exist",
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("CommentValidationError");
			expect((err as Error & {code?: string}).code).toBe("parent_not_found");
		}

		// No row landed.
		const summary = await env.PHOENIX_DB.prepare(
			"SELECT comment_count FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{comment_count: number}>();
		expect(summary!.comment_count).toBe(0);
	});

	it("rejects a nested reply whose parent lives on a different post", async () => {
		// Under D1-direct, every comment lives in one `comment_view`, so we
		// must explicitly enforce `post_id` match on the parent lookup — the
		// legacy DO routing did this for us by addressing the per-post DO.
		const postA = await seedPost({authorId: "p-author-cross-a", title: "A"});
		const postB = await seedPost({authorId: "p-author-cross-b", title: "B"});

		const parentOnA = await addComment(env, {
			postId: postA,
			authorId: "c-author-cross",
			authorName: "x",
			body: "parent on post A",
		});

		try {
			await addComment(env, {
				postId: postB,
				authorId: "c-author-cross-2",
				authorName: "y",
				body: "reply trying to reach across",
				parentId: parentOnA.commentId,
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("CommentValidationError");
			expect((err as Error & {code?: string}).code).toBe("parent_not_found");
		}
	});

	it("rejects empty / whitespace-only body", async () => {
		const postId = await seedPost({authorId: "p-author-4"});

		for (const body of ["", "    ", "\n\n\t"]) {
			try {
				await addComment(env, {
					postId,
					authorId: "c1",
					authorName: "c",
					body,
				});
				throw new Error(`expected rejection for body=${JSON.stringify(body)}`);
			} catch (err) {
				expect((err as Error).name).toBe("CommentValidationError");
				expect((err as Error & {code?: string}).code).toBe("body_required");
			}
		}
	});

	it("rejects bodies over 5 000 chars", async () => {
		const postId = await seedPost({authorId: "p-author-5"});

		try {
			await addComment(env, {
				postId,
				authorId: "c1",
				authorName: "c",
				body: "x".repeat(5_001),
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("CommentValidationError");
			expect((err as Error & {code?: string}).code).toBe("body_too_long");
		}
	});

	it("rejects when target post id doesn't exist", async () => {
		try {
			await addComment(env, {
				postId: "post_does_not_exist_at_all",
				authorId: "c1",
				authorName: "c",
				body: "hello",
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).name).toBe("PostNotFoundError");
		}
	});
});
