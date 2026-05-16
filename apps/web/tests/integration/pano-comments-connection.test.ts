/**
 * Pano post-detail comment connection (task_3, phoenix-relay-idiom).
 *
 * Exercises `PanoPost.listCommentsConnection` in workerd against a seeded
 * thread:
 *   - First page returns up to `first` rows + `hasNextPage` + `endCursor`.
 *   - Walking `after = endCursor` advances through every comment exactly once
 *     in chronological-asc order (the same order the legacy `listComments`
 *     reader's `asc(createdAt)` secondary sort produces).
 *   - `totalCount` reflects the materialized post-reply-aware list length —
 *     a soft-deleted-with-replies parent stays in the count; a soft-deleted
 *     leaf does NOT.
 *   - A stale cursor (pointing at a since-deleted comment) collapses to the
 *     head; the FE then reconciles against its store on the next page request.
 *
 * Mirrors the seeding pattern from `pano-add-comment.test.ts` and the
 * pagination test shape from `pano-post-connection.test.ts`.
 */
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import {id} from "@usirin/forge";
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

async function seedPostWithComments(opts: {
	authorId: string;
	authorName?: string;
	commentCount: number;
}) {
	const postId = id("post");
	const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
	await stub.submitPost({
		title: "comment connection test başlık",
		body: "comment connection test body",
		tags: [{kind: "tartışma"}],
		authorId: opts.authorId,
		authorName: opts.authorName ?? "post author",
	});
	const commentIds: string[] = [];
	for (let i = 0; i < opts.commentCount; i++) {
		const r = await stub.addComment({
			authorId: `c-author-${i}`,
			authorName: `commenter ${i}`,
			body: `comment ${i} body — long enough to satisfy minimum length`,
		});
		commentIds.push(r.commentId);
	}
	return {stub, postId, commentIds};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("PanoPost.listCommentsConnection — task_3", () => {
	it("paginates chronologically through every comment with a stable cursor", async () => {
		const {stub, commentIds} = await seedPostWithComments({
			authorId: "p-author-1",
			commentCount: 5,
		});

		// First page of 2.
		const page1 = await stub.listCommentsConnection({first: 2});
		expect(page1.rows).toHaveLength(2);
		expect(page1.hasNextPage).toBe(true);
		expect(page1.totalCount).toBe(5);
		expect(page1.rows.map((r) => r.id)).toEqual(commentIds.slice(0, 2));
		expect(page1.endCursor).toBe(commentIds[1]);

		// Second page of 2.
		const page2 = await stub.listCommentsConnection({first: 2, after: page1.endCursor});
		expect(page2.rows).toHaveLength(2);
		expect(page2.hasNextPage).toBe(true);
		expect(page2.totalCount).toBe(5);
		expect(page2.rows.map((r) => r.id)).toEqual(commentIds.slice(2, 4));
		expect(page2.endCursor).toBe(commentIds[3]);

		// Final page of 2 (only one row remaining).
		const page3 = await stub.listCommentsConnection({first: 2, after: page2.endCursor});
		expect(page3.rows).toHaveLength(1);
		expect(page3.hasNextPage).toBe(false);
		expect(page3.totalCount).toBe(5);
		expect(page3.rows.map((r) => r.id)).toEqual([commentIds[4]]);
	});

	it("reflects the reply-aware list length in totalCount (parent-with-replies stays, leaf-deleted is gone)", async () => {
		const {stub, commentIds} = await seedPostWithComments({
			authorId: "p-author-2",
			commentCount: 3,
		});
		// Add a reply so commentIds[0] is a parent-with-replies after deletion.
		const reply = await stub.addComment({
			authorId: "c-reply",
			authorName: "reply author",
			body: "child of comment 0 — keeps comment 0 alive as [silindi] placeholder",
			parentId: commentIds[0]!,
		});

		// Delete comment 0 (the parent) — its reply keeps it in the tree as
		// the [silindi] placeholder.
		await stub.deleteComment({commentId: commentIds[0]!, actorId: "c-author-0"});
		// Delete comment 2 (a leaf) — should be omitted from the tree entirely.
		await stub.deleteComment({commentId: commentIds[2]!, actorId: "c-author-2"});

		const page = await stub.listCommentsConnection({first: 50});
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

	it("collapses to the head on a stale cursor (since-deleted comment id)", async () => {
		const {stub, commentIds} = await seedPostWithComments({
			authorId: "p-author-3",
			commentCount: 3,
		});
		// Stale cursor — never existed in this thread.
		const stale = id("comm");
		const page = await stub.listCommentsConnection({first: 2, after: stale});
		expect(page.rows.map((r) => r.id)).toEqual(commentIds.slice(0, 2));
		expect(page.hasNextPage).toBe(true);
		expect(page.totalCount).toBe(3);
	});
});

describe("PanoPost.deleteComment placeholder shape — task_3", () => {
	it("returns a placeholder Comment row when the deleted comment has live replies", async () => {
		const {stub, commentIds} = await seedPostWithComments({
			authorId: "p-author-4",
			commentCount: 1,
		});
		await stub.addComment({
			authorId: "c-child",
			authorName: "child",
			body: "child of comment 0 keeping the parent alive",
			parentId: commentIds[0]!,
		});

		const result = await stub.deleteComment({
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
		const {stub, commentIds} = await seedPostWithComments({
			authorId: "p-author-5",
			commentCount: 1,
		});

		const result = await stub.deleteComment({
			commentId: commentIds[0]!,
			actorId: "c-author-0",
		});
		expect(result.deleted).toBe(true);
		expect(result.hasReplies).toBe(false);
		expect(result.placeholder).toBeNull();
	});
});
