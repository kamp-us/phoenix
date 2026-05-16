/**
 * PanoPost.voteOnPost / retractPostVote + VoteRecorded projection — task_8.
 *
 * Mirrors `sozluk-vote-definition.test.ts`. Exercises the producer pattern
 * (ADR 0007) for post vote events end-to-end inside workerd:
 *   1. Apply view migrations.
 *   2. Seed a post via `submitPost` (T7 path; lands the `post_summary` row).
 *   3. Cast a vote → score 0 → 1 → `user_vote` row exists →
 *      `user_profile.total_karma` for the author goes 0 → 1.
 *   4. Idempotency: a second vote from the same user is a no-op (score stays
 *      at 1, no duplicate karma bump, exactly one vote row).
 *   5. Retract the vote → score 0 → `user_vote` row gone → karma 0.
 *   6. Vote → unvote → vote round-trip restores score 1, karma 1, exactly
 *      one `user_vote` row.
 *   7. Outbox durability: a vote that fails workflow.create on the inline
 *      flush leaves the outbox row; `reconcileOutbox` re-queues and clears.
 *   8. PostNotFoundError for an empty DO.
 *   9. hot_score recomputes alongside score.
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
	predicate: (row: unknown) => boolean,
	attempts = 30,
): Promise<unknown> {
	for (let i = 0; i < attempts; i++) {
		const row = await env.PHOENIX_DB.prepare(sql)
			.bind(...params)
			.first();
		if (row && predicate(row)) return row;
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
}

async function seedPost(authorId: string, authorName: string) {
	const postId = id("post");
	const stub = env.PANO_POST.get(env.PANO_POST.idFromName(postId));
	await stub.submitPost({
		title: `seed post ${postId}`,
		tags: [{kind: "tartışma"}],
		authorId,
		authorName,
	});
	// Wait for post_summary to land so cross-product reads see the row.
	await waitForRow<{id: string}>("SELECT id FROM post_summary WHERE id = ?", [postId]);
	return {stub, postId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("PanoPost.voteOnPost — task_8", () => {
	it("casts a vote, recomputes score + hot_score, projects user_vote + karma", async () => {
		const authorId = "author-vote-1";
		const voterId = "voter-vote-1";
		const {stub, postId} = await seedPost(authorId, "umut");

		const result = await stub.voteOnPost({voterId});
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);
		expect(result.myVote).toBe(1);
		// hot_score is HN-style; positive after a cast on a fresh post.
		expect(result.hotScore).toBeGreaterThan(0);

		const post = await stub.getPost();
		expect(post!.score).toBe(1);

		// user_vote MV row landed.
		const voteRow = await waitForRow<{user_id: string}>(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_kind = 'post' AND target_id = ?",
			[voterId, postId],
		);
		expect(voteRow).not.toBeNull();

		// post_summary score + hot_score reflect the vote.
		const summary = await waitForCondition(
			"SELECT score, hot_score FROM post_summary WHERE id = ?",
			[postId],
			(r) => (r as {score: number}).score === 1,
		);
		expect(summary).not.toBeNull();
		expect((summary as {hot_score: number}).hot_score).toBeGreaterThan(0);

		// karma 0 → 1 for the author.
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			[authorId],
			(r) => (r as {total_karma: number}).total_karma === 1,
		);
		expect(profile).not.toBeNull();
	});

	it("two consecutive votes from the same user are idempotent (score stays at 1)", async () => {
		const authorId = "author-idem";
		const voterId = "voter-idem";
		const {stub, postId} = await seedPost(authorId, "umut");

		const first = await stub.voteOnPost({voterId});
		expect(first.score).toBe(1);
		expect(first.changed).toBe(true);

		const second = await stub.voteOnPost({voterId});
		expect(second.score).toBe(1);
		expect(second.changed).toBe(false);

		const post = await stub.getPost();
		expect(post!.score).toBe(1);

		// karma stays at 1 (not 2).
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			[authorId],
			(r) => (r as {total_karma: number}).total_karma === 1,
		);
		expect(profile).not.toBeNull();

		// vote table has exactly one row for this (post, voter).
		const voteCount = await runInDurableObject(stub, async (instance: any) => {
			const rows = instance.sql<{n: number}>`
				SELECT COUNT(*) as n FROM post_vote
				WHERE post_id = ${postId} AND voter_id = ${voterId}
			`;
			return rows[0]?.n ?? 0;
		});
		expect(voteCount).toBe(1);
	});

	it("retractPostVote removes the row, recomputes score, projects deletion", async () => {
		const authorId = "author-retract";
		const voterId = "voter-retract";
		const {stub, postId} = await seedPost(authorId, "umut");

		await stub.voteOnPost({voterId});
		await waitForRow<{user_id: string}>(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_kind = 'post' AND target_id = ?",
			[voterId, postId],
		);

		const retract = await stub.retractPostVote({voterId});
		expect(retract.score).toBe(0);
		expect(retract.changed).toBe(true);
		expect(retract.myVote).toBeNull();

		const post = await stub.getPost();
		expect(post!.score).toBe(0);

		// user_vote row removed.
		const removed = await waitForCondition(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
			[voterId, postId],
			(r) => (r as {n: number}).n === 0,
		);
		expect(removed).not.toBeNull();

		// karma decremented.
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			[authorId],
			(r) => (r as {total_karma: number}).total_karma === 0,
		);
		expect(profile).not.toBeNull();
	});

	it("retracting a vote that doesn't exist is a no-op", async () => {
		const authorId = "author-noop";
		const voterId = "voter-noop";
		const {stub} = await seedPost(authorId, "umut");

		const result = await stub.retractPostVote({voterId});
		expect(result.score).toBe(0);
		expect(result.changed).toBe(false);
	});

	it("vote → unvote → vote round-trip ends with score 1 and one user_vote row", async () => {
		const authorId = "author-rt";
		const voterId = "voter-rt";
		const {stub, postId} = await seedPost(authorId, "umut");

		await stub.voteOnPost({voterId});
		await stub.retractPostVote({voterId});
		const final = await stub.voteOnPost({voterId});
		expect(final.score).toBe(1);

		// user_vote has exactly one row.
		const voteRow = await waitForCondition(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
			[voterId, postId],
			(r) => (r as {n: number}).n === 1,
		);
		expect(voteRow).not.toBeNull();

		// karma at 1.
		const profile = await waitForCondition(
			"SELECT user_id, total_karma FROM user_profile WHERE user_id = ?",
			[authorId],
			(r) => (r as {total_karma: number}).total_karma === 1,
		);
		expect(profile).not.toBeNull();
	});

	it("workflow.create failure on vote leaves outbox rows; reconcileOutbox re-queues and clears", async () => {
		const authorId = "author-reconcile";
		const voterId = "voter-reconcile";
		const {stub} = await seedPost(authorId, "umut");

		const counts = await runInDurableObject(stub, async (instance: any) => {
			const original = instance.env.PHOENIX_PROJECTION.create.bind(
				instance.env.PHOENIX_PROJECTION,
			);
			let calls = 0;
			instance.env.PHOENIX_PROJECTION = {
				...instance.env.PHOENIX_PROJECTION,
				create: async (params: unknown) => {
					calls++;
					// Fail the first two create calls (PostChanged + VoteRecorded
					// for the cast). Subsequent reconcile retries hit the original.
					if (calls <= 2) throw new Error("simulated workflow create failure");
					return original(params);
				},
			};

			try {
				await instance.voteOnPost({voterId});
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

	it("voteOnPost on an empty DO rejects with PostNotFoundError", async () => {
		const stub = env.PANO_POST.get(env.PANO_POST.idFromName(id("post")));
		try {
			await stub.voteOnPost({voterId: "voter-x"});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).message).toMatch(/not found/i);
		}
	});
});
