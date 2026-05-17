/**
 * Pano D1-direct `voteOnPost` / `retractPostVote`.
 *
 * Exercises the module-functional path against `env.PHOENIX_DB`:
 *   1. Apply view migrations (including 0006).
 *   2. Seed a post via `submitPost` (D1-direct).
 *   3. Cast a vote → `post_summary.score` 0 → 1 → `user_vote` row exists →
 *      `user_profile.total_karma` for the author goes 0 → 1.
 *   4. Idempotency: a second vote from the same user is a no-op (score
 *      stays at 1, exactly one vote row, karma stays at 1).
 *   5. Retract the vote → score 0 → `user_vote` row gone → karma 0.
 *   6. Vote → unvote → vote round-trip restores score 1, karma 1,
 *      exactly one `user_vote` row.
 *   7. PostNotFoundError for an unknown post id.
 *   8. hot_score recomputes alongside score.
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
	PostNotFoundError,
	retractPostVote,
	submitPost,
	voteOnPost,
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

async function seedPost(authorId: string, authorName = "umut") {
	const result = await submitPost(env, {
		title: `seed post ${Math.random().toString(36).slice(2)}`,
		tags: [{kind: "tartışma"}],
		authorId,
		authorName,
	});
	return {postId: result.postId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("pano.voteOnPost", () => {
	it("casts a vote, recomputes score + hot_score, projects user_vote + karma", async () => {
		const authorId = "author-vote-1";
		const voterId = "voter-vote-1";
		const {postId} = await seedPost(authorId);

		const result = await voteOnPost(env, {postId, voterId});
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);
		expect(result.myVote).toBe(1);
		// hot_score is HN-style; positive after a cast on a fresh post.
		expect(result.hotScore).toBeGreaterThan(0);

		// post_summary score + hot_score reflect the vote.
		const summary = (await env.PHOENIX_DB.prepare(
			"SELECT score, hot_score FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first()) as {score: number; hot_score: number} | null;
		expect(summary).not.toBeNull();
		expect(summary!.score).toBe(1);
		expect(summary!.hot_score).toBeGreaterThan(0);

		// user_vote MV row landed.
		const voteRow = await env.PHOENIX_DB.prepare(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_kind = 'post' AND target_id = ?",
		)
			.bind(voterId, postId)
			.first();
		expect(voteRow).not.toBeNull();

		// karma 0 → 1 for the author.
		const profile = (await env.PHOENIX_DB.prepare(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {user_id: string; total_karma: number} | null;
		expect(profile).not.toBeNull();
		expect(profile!.total_karma).toBe(1);
	});

	it("two consecutive votes from the same user are idempotent (score stays at 1)", async () => {
		const authorId = "author-idem";
		const voterId = "voter-idem";
		const {postId} = await seedPost(authorId);

		const first = await voteOnPost(env, {postId, voterId});
		expect(first.score).toBe(1);
		expect(first.changed).toBe(true);

		const second = await voteOnPost(env, {postId, voterId});
		expect(second.score).toBe(1);
		expect(second.changed).toBe(false);

		// karma stays at 1 (not 2).
		const profile = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(profile!.total_karma).toBe(1);

		// post_vote table has exactly one row for this (post, voter).
		const voteCount = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM post_vote WHERE post_id = ? AND voter_id = ?",
		)
			.bind(postId, voterId)
			.first()) as {n: number} | null;
		expect(voteCount!.n).toBe(1);
	});

	it("retractPostVote removes the row, recomputes score, projects deletion", async () => {
		const authorId = "author-retract";
		const voterId = "voter-retract";
		const {postId} = await seedPost(authorId);

		await voteOnPost(env, {postId, voterId});

		const retract = await retractPostVote(env, {postId, voterId});
		expect(retract.score).toBe(0);
		expect(retract.changed).toBe(true);
		expect(retract.myVote).toBeNull();

		// user_vote row removed.
		const voteCount = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
		)
			.bind(voterId, postId)
			.first()) as {n: number} | null;
		expect(voteCount!.n).toBe(0);

		// karma decremented.
		const profile = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(profile!.total_karma).toBe(0);
	});

	it("retracting a vote that doesn't exist is a no-op", async () => {
		const authorId = "author-noop";
		const voterId = "voter-noop";
		const {postId} = await seedPost(authorId);

		const result = await retractPostVote(env, {postId, voterId});
		expect(result.score).toBe(0);
		expect(result.changed).toBe(false);
	});

	it("vote → unvote → vote round-trip ends with score 1 and one user_vote row", async () => {
		const authorId = "author-rt";
		const voterId = "voter-rt";
		const {postId} = await seedPost(authorId);

		await voteOnPost(env, {postId, voterId});
		await retractPostVote(env, {postId, voterId});
		const final = await voteOnPost(env, {postId, voterId});
		expect(final.score).toBe(1);

		// user_vote has exactly one row.
		const voteRow = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
		)
			.bind(voterId, postId)
			.first()) as {n: number} | null;
		expect(voteRow!.n).toBe(1);

		// karma at 1.
		const profile = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(profile!.total_karma).toBe(1);
	});

	it("voteOnPost on an unknown post id rejects with PostNotFoundError", async () => {
		try {
			await voteOnPost(env, {postId: "post_DOES_NOT_EXIST", voterId: "voter-x"});
			throw new Error("expected rejection");
		} catch (err) {
			expect(err).toBeInstanceOf(PostNotFoundError);
			expect((err as Error).message).toMatch(/not found/i);
		}
	});
});
