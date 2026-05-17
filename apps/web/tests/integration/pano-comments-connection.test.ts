/**
 * `listCommentsConnection` on D1-direct.
 *
 * Exercises the D1-direct connection-shaped comment reader against a
 * seeded thread:
 *   - First page returns up to `first` rows + `hasNextPage` + `endCursor`.
 *   - Walking `after = endCursor` advances through every comment exactly
 *     once in chronological-asc order.
 *   - `totalCount` reflects the materialized post-reply-aware list length
 *     — a soft-deleted-with-replies parent stays in the count; a
 *     soft-deleted leaf does NOT (leaf rows are fully removed from
 *     `comment_view`).
 *   - A stale cursor (pointing at a never-existed comment OR a comment
 *     that was removed between pages) returns an empty page with
 *     `hasNextPage: false` and `endCursor: null` so the FE store doesn't
 *     re-render rows it has already seen. Mirrors `listPostConnection`'s
 *     `cursorMissed` early-return.
 *   - `deleteComment` placeholder shape (reply-aware): parent-with-replies
 *     returns the placeholder row; leaf-delete returns `null`.
 *
 * Zero `runInDurableObject` blocks — the module reads/writes D1 directly.
 */
import {env} from "cloudflare:test";
import {id} from "@usirin/forge";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {
	addComment,
	deleteComment,
	listCommentsConnection,
	submitPost,
} from "../../worker/features/pano/module";

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

async function seedPostWithComments(opts: {
	authorId: string;
	authorName?: string;
	commentCount: number;
}) {
	const post = await submitPost(env, {
		title: "comment connection test başlık",
		body: "comment connection test body",
		tags: [{kind: "tartışma"}],
		authorId: opts.authorId,
		authorName: opts.authorName ?? "post author",
	});
	const commentIds: string[] = [];
	for (let i = 0; i < opts.commentCount; i++) {
		const r = await addComment(env, {
			postId: post.postId,
			authorId: `c-author-${i}`,
			authorName: `commenter ${i}`,
			body: `comment ${i} body — long enough to satisfy minimum length`,
		});
		commentIds.push(r.commentId);
	}
	return {postId: post.postId, commentIds};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("pano/module listCommentsConnection", () => {
	it("paginates chronologically through every comment with a stable cursor", async () => {
		const {postId, commentIds} = await seedPostWithComments({
			authorId: "p-author-1",
			commentCount: 5,
		});

		// First page of 2.
		const page1 = await listCommentsConnection(env, postId, {first: 2});
		expect(page1.rows).toHaveLength(2);
		expect(page1.hasNextPage).toBe(true);
		expect(page1.totalCount).toBe(5);
		expect(page1.rows.map((r) => r.id)).toEqual(commentIds.slice(0, 2));
		expect(page1.endCursor).toBe(commentIds[1]);

		// Second page of 2.
		const page2 = await listCommentsConnection(env, postId, {
			first: 2,
			after: page1.endCursor,
		});
		expect(page2.rows).toHaveLength(2);
		expect(page2.hasNextPage).toBe(true);
		expect(page2.totalCount).toBe(5);
		expect(page2.rows.map((r) => r.id)).toEqual(commentIds.slice(2, 4));
		expect(page2.endCursor).toBe(commentIds[3]);

		// Final page (only one row remaining).
		const page3 = await listCommentsConnection(env, postId, {
			first: 2,
			after: page2.endCursor,
		});
		expect(page3.rows).toHaveLength(1);
		expect(page3.hasNextPage).toBe(false);
		expect(page3.totalCount).toBe(5);
		expect(page3.rows.map((r) => r.id)).toEqual([commentIds[4]]);
	});

	it("reflects the reply-aware list length in totalCount (parent-with-replies stays, leaf-deleted is gone)", async () => {
		const {postId, commentIds} = await seedPostWithComments({
			authorId: "p-author-2",
			commentCount: 3,
		});
		// Add a reply so commentIds[0] is a parent-with-replies after deletion.
		const reply = await addComment(env, {
			postId,
			authorId: "c-reply",
			authorName: "reply author",
			body: "child of comment 0 — keeps comment 0 alive as [silindi] placeholder",
			parentId: commentIds[0]!,
		});

		// Delete comment 0 (the parent) — its reply keeps it in the tree as
		// the [silindi] placeholder.
		await deleteComment(env, {commentId: commentIds[0]!, actorId: "c-author-0"});
		// Delete comment 2 (a leaf) — should be removed from the tree entirely.
		await deleteComment(env, {commentId: commentIds[2]!, actorId: "c-author-2"});

		const page = await listCommentsConnection(env, postId, {first: 50});
		const ids = page.rows.map((r) => r.id);
		// Surviving rows: parent placeholder (comment 0), comment 1, reply.
		// Comment 2 is fully removed (leaf delete).
		expect(ids).toContain(commentIds[0]);
		expect(ids).toContain(commentIds[1]);
		expect(ids).toContain(reply.commentId);
		expect(ids).not.toContain(commentIds[2]);
		expect(page.totalCount).toBe(3);

		// The placeholder row carries `body = '[silindi]'` AND `deletedAt` set.
		const placeholder = page.rows.find((r) => r.id === commentIds[0]);
		expect(placeholder).toBeDefined();
		expect(placeholder!.body).toBe("[silindi]");
		expect(placeholder!.authorId).toBe("");
		expect(placeholder!.deletedAt).not.toBeNull();
		expect(placeholder!.deletedAt instanceof Date).toBe(true);

		// Live comments report a null deletedAt.
		const live = page.rows.find((r) => r.id === commentIds[1]);
		expect(live!.deletedAt).toBeNull();
	});

	it("returns an empty page on a stale cursor (never-existed comment id)", async () => {
		const {postId} = await seedPostWithComments({
			authorId: "p-author-3",
			commentCount: 3,
		});
		const stale = id("comm");
		const page = await listCommentsConnection(env, postId, {first: 2, after: stale});
		expect(page.rows).toEqual([]);
		expect(page.hasNextPage).toBe(false);
		expect(page.endCursor).toBeNull();
		expect(page.totalCount).toBe(3);
	});

	it("returns an empty page when the `after` row was removed between pages", async () => {
		const {postId, commentIds} = await seedPostWithComments({
			authorId: "p-author-6",
			commentCount: 4,
		});
		// Page through the first two rows with a stable cursor.
		const page1 = await listCommentsConnection(env, postId, {first: 2});
		expect(page1.endCursor).toBe(commentIds[1]);
		expect(page1.hasNextPage).toBe(true);

		// Hard-delete the cursor row (leaf, no replies → removed from
		// `comment_view` entirely). The next page request now carries a
		// cursor that no longer exists in the materialized list.
		await deleteComment(env, {commentId: commentIds[1]!, actorId: "c-author-1"});

		const page2 = await listCommentsConnection(env, postId, {
			first: 2,
			after: page1.endCursor,
		});
		expect(page2.rows).toEqual([]);
		expect(page2.hasNextPage).toBe(false);
		expect(page2.endCursor).toBeNull();
		// totalCount reflects the new list length after the delete (3 rows).
		expect(page2.totalCount).toBe(3);
	});
});

describe("pano/module deleteComment placeholder shape", () => {
	it("returns a placeholder Comment row when the deleted comment has live replies", async () => {
		const {postId, commentIds} = await seedPostWithComments({
			authorId: "p-author-4",
			commentCount: 1,
		});
		await addComment(env, {
			postId,
			authorId: "c-child",
			authorName: "child",
			body: "child of comment 0 keeping the parent alive",
			parentId: commentIds[0]!,
		});

		const result = await deleteComment(env, {
			commentId: commentIds[0]!,
			actorId: "c-author-0",
		});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(true);
		expect(result.placeholder).not.toBeNull();
		expect(result.placeholder!.id).toBe(commentIds[0]);
		expect(result.placeholder!.body).toBe("[silindi]");
		expect(result.placeholder!.authorId).toBe("");
		expect(result.placeholder!.deletedAt).not.toBeNull();
	});

	it("returns null placeholder for a leaf delete (no live children)", async () => {
		const {commentIds} = await seedPostWithComments({
			authorId: "p-author-5",
			commentCount: 1,
		});

		const result = await deleteComment(env, {
			commentId: commentIds[0]!,
			actorId: "c-author-0",
		});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(false);
		expect(result.placeholder).toBeNull();
	});
});
