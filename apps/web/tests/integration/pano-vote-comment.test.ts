/**
 * PanoPost.voteOnComment / retractCommentVote + VoteRecorded + CommentChanged
 * projections — task_11.
 *
 * Mirrors `pano-vote-post.test.ts` (task_8). Exercises the producer pattern
 * (ADR 0007) for comment vote events end-to-end inside workerd:
 *   1. Apply view migrations.
 *   2. Seed a post + add a comment (T7 + T10 paths).
 *   3. Cast a vote → score 0 → 1 → comment_vote row exists →
 *      `user_vote` MV row exists → `user_profile.total_karma` for the comment's
 *      author goes 0 → 1 → `comment_view.score` converges to 1.
 *   4. Idempotency: a second vote from the same user is a no-op.
 *   5. Retract the vote → score 0 → user_vote row gone → karma 0 → comment_view
 *      score 0.
 *   6. Vote → unvote → vote round-trip restores score 1, karma 1, exactly one
 *      `user_vote` row.
 *   7. Outbox durability: a vote that fails workflow.create leaves the outbox
 *      row; `reconcileOutbox` re-queues and clears.
 *   8. CommentNotFoundError for an unknown comment id.
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

async function seedPostAndComment(opts: {
	postAuthorId: string;
	commentAuthorId: string;
	commentBody?: string;
}) {
	const postId = id("post");
	const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
	await stub.submitPost({
		title: `vote-on-comment seed ${postId}`,
		tags: [{kind: "tartışma"}],
		authorId: opts.postAuthorId,
		authorName: "post author",
	});
	await waitForRow<{id: string}>("SELECT id FROM post_summary WHERE id = ?", [postId]);

	const comment = await stub.addComment({
		authorId: opts.commentAuthorId,
		authorName: "comment author",
		body: opts.commentBody ?? "a comment to vote on",
	});

	// Wait for comment_view to land so cross-product reads see the row.
	await waitForRow<{id: string}>("SELECT id FROM comment_view WHERE id = ?", [comment.commentId]);

	return {stub, postId, commentId: comment.commentId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("PanoPost.voteOnComment — task_11", () => {
	it("casts a vote, recomputes comment.score, projects user_vote + karma + comment_view", async () => {
		const postAuthorId = "p-author-cv-1";
		const commentAuthorId = "c-author-cv-1";
		const voterId = "voter-cv-1";
		const {stub, commentId} = await seedPostAndComment({postAuthorId, commentAuthorId});

		const result = await stub.voteOnComment({commentId, voterId});
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);
		expect(result.myVote).toBe(1);
		expect(result.commentId).toBe(commentId);

		// In-DO: comment.score reflects the vote.
		const comments = await stub.listComments();
		const target = comments.find((c) => c.id === commentId);
		expect(target!.score).toBe(1);

		// user_vote MV row landed for target_kind='comment'.
		const voteRow = await waitForRow<{user_id: string}>(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_kind = 'comment' AND target_id = ?",
			[voterId, commentId],
		);
		expect(voteRow).not.toBeNull();

		// comment_view.score converged to 1.
		const view = await waitForCondition(
			"SELECT score FROM comment_view WHERE id = ?",
			[commentId],
			(r) => r != null && (r as {score: number}).score === 1,
		);
		expect(view).not.toBeNull();

		// karma 0 → 1 for the comment's author (NOT the post author).
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			[commentAuthorId],
			(r) => r != null && (r as {total_karma: number}).total_karma === 1,
		);
		expect(profile).not.toBeNull();
	});

	it("two consecutive votes from the same user are idempotent (score stays at 1)", async () => {
		const {stub, commentId} = await seedPostAndComment({
			postAuthorId: "p-author-cv-idem",
			commentAuthorId: "c-author-cv-idem",
		});
		const voterId = "voter-cv-idem";

		const first = await stub.voteOnComment({commentId, voterId});
		expect(first.score).toBe(1);
		expect(first.changed).toBe(true);

		const second = await stub.voteOnComment({commentId, voterId});
		expect(second.score).toBe(1);
		expect(second.changed).toBe(false);

		const comments = await stub.listComments();
		const target = comments.find((c) => c.id === commentId);
		expect(target!.score).toBe(1);

		// karma stays at 1 (not 2).
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			["c-author-cv-idem"],
			(r) => r != null && (r as {total_karma: number}).total_karma === 1,
		);
		expect(profile).not.toBeNull();

		// vote table has exactly one row for this (comment, voter).
		const voteCount = await runInDurableObject(stub, async (instance: any) => {
			const rows = instance.sql<{n: number}>`
				SELECT COUNT(*) as n FROM comment_vote
				WHERE comment_id = ${commentId} AND voter_id = ${voterId}
			`;
			return rows[0]?.n ?? 0;
		});
		expect(voteCount).toBe(1);
	});

	it("retractCommentVote removes the row, recomputes score, projects deletion", async () => {
		const postAuthorId = "p-author-cv-retract";
		const commentAuthorId = "c-author-cv-retract";
		const voterId = "voter-cv-retract";
		const {stub, commentId} = await seedPostAndComment({postAuthorId, commentAuthorId});

		await stub.voteOnComment({commentId, voterId});
		await waitForRow<{user_id: string}>(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_kind = 'comment' AND target_id = ?",
			[voterId, commentId],
		);

		const retract = await stub.retractCommentVote({commentId, voterId});
		expect(retract.score).toBe(0);
		expect(retract.changed).toBe(true);
		expect(retract.myVote).toBeNull();

		const comments = await stub.listComments();
		const target = comments.find((c) => c.id === commentId);
		expect(target!.score).toBe(0);

		// user_vote row removed.
		const removed = await waitForCondition(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
			[voterId, commentId],
			(r) => r != null && (r as {n: number}).n === 0,
		);
		expect(removed).not.toBeNull();

		// comment_view.score back to 0.
		const view = await waitForCondition(
			"SELECT score FROM comment_view WHERE id = ?",
			[commentId],
			(r) => r != null && (r as {score: number}).score === 0,
		);
		expect(view).not.toBeNull();

		// karma decremented.
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			[commentAuthorId],
			(r) => r != null && (r as {total_karma: number}).total_karma === 0,
		);
		expect(profile).not.toBeNull();
	});

	it("retracting a vote that doesn't exist is a no-op", async () => {
		const {stub, commentId} = await seedPostAndComment({
			postAuthorId: "p-author-cv-noop",
			commentAuthorId: "c-author-cv-noop",
		});

		const result = await stub.retractCommentVote({commentId, voterId: "voter-cv-noop"});
		expect(result.score).toBe(0);
		expect(result.changed).toBe(false);
	});

	it("vote → unvote → vote round-trip ends with score 1 and one user_vote row", async () => {
		const postAuthorId = "p-author-cv-rt";
		const commentAuthorId = "c-author-cv-rt";
		const voterId = "voter-cv-rt";
		const {stub, commentId} = await seedPostAndComment({postAuthorId, commentAuthorId});

		await stub.voteOnComment({commentId, voterId});
		await stub.retractCommentVote({commentId, voterId});
		const final = await stub.voteOnComment({commentId, voterId});
		expect(final.score).toBe(1);

		// user_vote has exactly one row.
		const voteRow = await waitForCondition(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
			[voterId, commentId],
			(r) => r != null && (r as {n: number}).n === 1,
		);
		expect(voteRow).not.toBeNull();

		// karma at 1 for the comment author.
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			[commentAuthorId],
			(r) => r != null && (r as {total_karma: number}).total_karma === 1,
		);
		expect(profile).not.toBeNull();
	});

	it("workflow.create failure on vote leaves outbox rows; reconcileOutbox re-queues and clears", async () => {
		const {stub, commentId} = await seedPostAndComment({
			postAuthorId: "p-author-cv-reconcile",
			commentAuthorId: "c-author-cv-reconcile",
		});

		const counts = await runInDurableObject(stub, async (instance: any) => {
			const original = instance.env.PHOENIX_PROJECTION.create.bind(
				instance.env.PHOENIX_PROJECTION,
			);
			let calls = 0;
			instance.env.PHOENIX_PROJECTION = {
				...instance.env.PHOENIX_PROJECTION,
				create: async (params: unknown) => {
					calls++;
					// Fail the first two create calls (CommentChanged + VoteRecorded
					// for the cast). Subsequent reconcile retries hit the original.
					if (calls <= 2) throw new Error("simulated workflow create failure");
					return original(params);
				},
			};

			try {
				await instance.voteOnComment({commentId, voterId: "voter-cv-reconcile"});
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

	it("voteOnComment on an unknown comment id rejects with CommentNotFoundError", async () => {
		const {stub} = await seedPostAndComment({
			postAuthorId: "p-author-cv-missing",
			commentAuthorId: "c-author-cv-missing",
		});
		try {
			await stub.voteOnComment({commentId: "comm_DOES_NOT_EXIST", voterId: "voter-x"});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).message).toMatch(/not found/i);
		}
	});
});
