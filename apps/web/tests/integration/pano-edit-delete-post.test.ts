/**
 * Pano D1-direct `editPost` / `deletePost` (task_7, d1-direct).
 *
 * Exercises the module-functional path against `env.PHOENIX_DB`:
 *   1. Apply view migrations (including 0006).
 *   2. Seed a post via `submitPost` (D1-direct).
 *   3. Edit title / body → `post_summary` reflects the new values
 *      (body + body_excerpt + updated_at).
 *   4. Ownership: a non-author actor's edit / delete throws
 *      `UnauthorizedPostMutationError`.
 *   5. Delete → fully removes the `post_summary` row (matches the legacy
 *      `PostDeleted` semantics: posts disappear from the feed entirely,
 *      vs. soft-delete for definitions). Drops `post_vote` + `user_vote`
 *      mirrors; decrements karma.
 *   6. Idempotent re-delete on a missing row is a no-op.
 *   7. Validation: at least one of title/body required; title cap; body cap.
 *
 * No `runInDurableObject`, no outbox, no projection workflow — the writes
 * are inline D1 (ADR 0009).
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import viewMigration0000 from "../../worker/db/drizzle/migrations/0000_secret_iron_patriot.sql";
import viewMigration0001 from "../../worker/db/drizzle/migrations/0001_free_salo.sql";
import viewMigration0002 from "../../worker/db/drizzle/migrations/0002_wandering_natasha_romanoff.sql";
import viewMigration0003 from "../../worker/db/drizzle/migrations/0003_lazy_thanos.sql";
import viewMigration0004 from "../../worker/db/drizzle/migrations/0004_brown_squadron_supreme.sql";
import viewMigration0005 from "../../worker/db/drizzle/migrations/0005_d1_direct_sozluk.sql";
import viewMigration0006 from "../../worker/db/drizzle/migrations/0006_d1_direct_pano.sql";
import {
	deletePost,
	editPost,
	PostValidationError,
	submitPost,
	UnauthorizedPostMutationError,
	voteOnPost,
} from "../../worker/features/pano/module";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

async function applyViewMigrations() {
	const sources = [
		viewMigration0000,
		viewMigration0001,
		viewMigration0002,
		viewMigration0003,
		viewMigration0004,
		viewMigration0005,
		viewMigration0006,
	];
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
	body?: string;
}) {
	const result = await submitPost(env, {
		title: opts.title ?? "original title",
		body: opts.body ?? "original body",
		tags: [{kind: "tartışma"}],
		authorId: opts.authorId,
		authorName: opts.authorName ?? "umut",
	});
	return {postId: result.postId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("pano.editPost — task_7", () => {
	it("updates title + body inline on post_summary (body + body_excerpt + updated_at)", async () => {
		const authorId = "edit-post-author";
		const {postId} = await seedPost({authorId});

		const before = (await env.PHOENIX_DB.prepare(
			"SELECT title, body, body_excerpt FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first()) as {title: string; body: string; body_excerpt: string};
		expect(before.title).toBe("original title");
		expect(before.body).toBe("original body");

		const result = await editPost(env, {
			postId,
			actorId: authorId,
			title: "edited title — fresh",
			body: "edited body — significantly different content here.",
		});
		expect(result.title).toBe("edited title — fresh");
		expect(result.body).toContain("edited body");
		expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(result.createdAt.getTime());

		const after = (await env.PHOENIX_DB.prepare(
			"SELECT title, body, body_excerpt FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first()) as {title: string; body: string; body_excerpt: string};
		expect(after.title).toBe("edited title — fresh");
		expect(after.body).toContain("edited body");
		expect(after.body_excerpt).toContain("edited body");
	});

	it("allows editing title alone", async () => {
		const authorId = "edit-title-only";
		const {postId} = await seedPost({authorId});

		await editPost(env, {postId, actorId: authorId, title: "title-only edit"});

		const row = (await env.PHOENIX_DB.prepare("SELECT title, body FROM post_summary WHERE id = ?")
			.bind(postId)
			.first()) as {title: string; body: string};
		expect(row.title).toBe("title-only edit");
		expect(row.body).toBe("original body");
	});

	it("allows editing body alone", async () => {
		const authorId = "edit-body-only";
		const {postId} = await seedPost({authorId});

		await editPost(env, {postId, actorId: authorId, body: "body-only edit"});

		const row = (await env.PHOENIX_DB.prepare("SELECT title, body FROM post_summary WHERE id = ?")
			.bind(postId)
			.first()) as {title: string; body: string};
		expect(row.title).toBe("original title");
		expect(row.body).toBe("body-only edit");
	});

	it("rejects when neither title nor body provided", async () => {
		const authorId = "edit-empty";
		const {postId} = await seedPost({authorId});

		try {
			await editPost(env, {postId, actorId: authorId});
			throw new Error("expected rejection");
		} catch (err) {
			expect(err).toBeInstanceOf(PostValidationError);
		}
	});

	it("rejects empty title (trim)", async () => {
		const authorId = "edit-blank-title";
		const {postId} = await seedPost({authorId});

		try {
			await editPost(env, {postId, actorId: authorId, title: "   "});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).message).toMatch(/boş olamaz|gerekli/i);
		}
	});

	it("rejects titles over 200 chars", async () => {
		const authorId = "edit-title-long";
		const {postId} = await seedPost({authorId});

		try {
			await editPost(env, {postId, actorId: authorId, title: "x".repeat(201)});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).message).toMatch(/200|en fazla/i);
		}
	});

	it("rejects bodies over 10 000 chars", async () => {
		const authorId = "edit-body-long";
		const {postId} = await seedPost({authorId});

		try {
			await editPost(env, {postId, actorId: authorId, body: "x".repeat(10_001)});
			throw new Error("expected rejection");
		} catch (err) {
			expect((err as Error).message).toMatch(/10\s?000|en fazla/i);
		}
	});

	it("ownership: non-author edit is rejected with UnauthorizedPostMutationError", async () => {
		const authorId = "owner-post";
		const otherId = "intruder-post";
		const {postId} = await seedPost({authorId, title: "owner's title"});

		try {
			await editPost(env, {
				postId,
				actorId: otherId,
				title: "intruder's title rewrite",
			});
			throw new Error("expected rejection");
		} catch (err) {
			expect(err).toBeInstanceOf(UnauthorizedPostMutationError);
			expect((err as Error).message).toMatch(/not authorized/i);
		}

		// The post did NOT change.
		const row = (await env.PHOENIX_DB.prepare("SELECT title FROM post_summary WHERE id = ?")
			.bind(postId)
			.first()) as {title: string};
		expect(row.title).toBe("owner's title");
	});
});

describe("pano.deletePost — task_7", () => {
	it("fully removes the row from post_summary (matches legacy PostDeleted semantics)", async () => {
		const authorId = "delete-post-author";
		const {postId} = await seedPost({authorId});

		// Sanity: post_summary has the row pre-delete.
		const before = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
			.bind(postId)
			.first();
		expect(before).not.toBeNull();

		const result = await deletePost(env, {postId, actorId: authorId});
		expect(result.deleted).toBe(true);

		// post_summary row is fully removed.
		const after = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
			.bind(postId)
			.first();
		expect(after).toBeNull();
	});

	it("ownership: non-author delete is rejected with UnauthorizedPostMutationError", async () => {
		const authorId = "owner-del";
		const otherId = "intruder-del";
		const {postId} = await seedPost({authorId});

		try {
			await deletePost(env, {postId, actorId: otherId});
			throw new Error("expected rejection");
		} catch (err) {
			expect(err).toBeInstanceOf(UnauthorizedPostMutationError);
		}

		// The post is still there.
		const row = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
			.bind(postId)
			.first();
		expect(row).not.toBeNull();
	});

	it("re-deleting an already-deleted post is an idempotent no-op", async () => {
		const authorId = "delete-idem";
		const {postId} = await seedPost({authorId});

		const first = await deletePost(env, {postId, actorId: authorId});
		expect(first.deleted).toBe(true);

		const second = await deletePost(env, {postId, actorId: authorId});
		expect(second.deleted).toBe(false);
	});

	it("decrements pano_stats.total_posts on delete", async () => {
		const authorId = "delete-stats";
		const {postId} = await seedPost({authorId});

		const beforeStats = (await env.PHOENIX_DB.prepare(
			"SELECT total_posts FROM pano_stats WHERE id = 1",
		).first()) as {total_posts: number} | null;
		const beforeCount = beforeStats?.total_posts ?? 0;
		expect(beforeCount).toBeGreaterThanOrEqual(1);

		await deletePost(env, {postId, actorId: authorId});

		const afterStats = (await env.PHOENIX_DB.prepare(
			"SELECT total_posts FROM pano_stats WHERE id = 1",
		).first()) as {total_posts: number} | null;
		expect(afterStats!.total_posts).toBe(beforeCount - 1);

		// Sanity: post_summary row gone.
		const row = await env.PHOENIX_DB.prepare("SELECT id FROM post_summary WHERE id = ?")
			.bind(postId)
			.first();
		expect(row).toBeNull();
	});

	it("drops post_vote + user_vote mirror rows and decrements karma by the prior score", async () => {
		const authorId = "delete-with-votes-author";
		const voterId = "delete-with-votes-voter";
		const {postId} = await seedPost({authorId});

		await voteOnPost(env, {postId, voterId});

		const karmaBefore = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(karmaBefore!.total_karma).toBe(1);

		await deletePost(env, {postId, actorId: authorId});

		// post_vote rows for the post are gone.
		const postVotes = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM post_vote WHERE post_id = ?",
		)
			.bind(postId)
			.first()) as {n: number} | null;
		expect(postVotes!.n).toBe(0);

		// user_vote mirror rows for the post are gone.
		const userVotes = (await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE target_kind = 'post' AND target_id = ?",
		)
			.bind(postId)
			.first()) as {n: number} | null;
		expect(userVotes!.n).toBe(0);

		// karma decremented to 0.
		const karmaAfter = (await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first()) as {total_karma: number} | null;
		expect(karmaAfter!.total_karma).toBe(0);
	});
});

/**
 * Atomicity invariant (d1-direct-review-fixes task_2).
 *
 * A successful `deletePost(...)` must collapse every mutating statement —
 * the conditional karma decrement, `DELETE FROM post_vote`, `DELETE FROM
 * user_vote`, and the `DELETE FROM post_summary` — into one
 * `env.PHOENIX_DB.batch([...])` call. The downstream `recomputePanoStats`
 * call stays out of the batch (recomputable cache; not atomicity-critical).
 *
 * Branches:
 *   - `priorScore === 0` → batch has 3 statements (karma omitted).
 *   - `priorScore > 0`  → batch has 4 statements, karma decrement first.
 */
describe("pano.deletePost — atomic single-batch write (d1-direct-review-fixes task_2)", () => {
	/**
	 * Wraps `env` so callers can spy on `PHOENIX_DB.batch` and the
	 * `.prepare(sql).bind(...).run()` chain without losing the real D1
	 * binding's behaviour. `.prepare(sql)` still returns a real
	 * `D1PreparedStatement` — we only intercept `.run()` and `.bind()` (to
	 * keep the wrapper covering the bound copy); everything else
	 * (`.first`, `.all`, `.raw`) passes through unchanged.
	 *
	 * Identical shape to the vote-module spy (vote-module.test.ts) so the
	 * `.bind().run()` chain is covered if `deletePost` ever moves from
	 * drizzle-builder to raw prepared statements.
	 */
	function spyEnv(real: Env) {
		let batchCalls = 0;
		const batchStatementCounts: number[] = [];
		let runCalls = 0;
		const realDb = real.PHOENIX_DB;
		const wrappedStatement = (stmt: D1PreparedStatement): D1PreparedStatement => {
			return new Proxy(stmt, {
				get(target, prop, receiver) {
					const orig = Reflect.get(target, prop, receiver);
					if (prop === "run" && typeof orig === "function") {
						return (...args: unknown[]) => {
							runCalls += 1;
							return (orig as (...a: unknown[]) => unknown).apply(target, args);
						};
					}
					if (prop === "bind" && typeof orig === "function") {
						return (...args: unknown[]) => {
							const bound = (orig as (...a: unknown[]) => D1PreparedStatement).apply(target, args);
							return wrappedStatement(bound);
						};
					}
					return typeof orig === "function" ? orig.bind(target) : orig;
				},
			});
		};
		const wrappedDb = new Proxy(realDb, {
			get(target, prop, receiver) {
				const orig = Reflect.get(target, prop, receiver);
				if (prop === "batch" && typeof orig === "function") {
					return (stmts: D1PreparedStatement[]) => {
						batchCalls += 1;
						batchStatementCounts.push(stmts.length);
						return (orig as (s: D1PreparedStatement[]) => unknown).call(target, stmts);
					};
				}
				if (prop === "prepare" && typeof orig === "function") {
					return (sql: string) => {
						const stmt = (orig as (s: string) => D1PreparedStatement).call(target, sql);
						return wrappedStatement(stmt);
					};
				}
				return typeof orig === "function" ? orig.bind(target) : orig;
			},
		});
		const wrappedEnv = new Proxy(real, {
			get(target, prop, receiver) {
				if (prop === "PHOENIX_DB") return wrappedDb;
				return Reflect.get(target, prop, receiver);
			},
		}) as Env;
		return {
			env: wrappedEnv,
			getCounts: () => ({
				batchCalls,
				batchStatementCounts: [...batchStatementCounts],
				runCalls,
			}),
		};
	}

	it("priorScore === 0: one batch with 3 statements (post_vote + user_vote + post_summary), no karma", async () => {
		const authorId = "atomic-del-zero-score";
		const {postId} = await seedPost({authorId});

		// Sanity: no votes were cast, so post_summary.score is still 0.
		const meta = (await env.PHOENIX_DB.prepare("SELECT score FROM post_summary WHERE id = ?")
			.bind(postId)
			.first()) as {score: number} | null;
		expect(meta!.score).toBe(0);

		const spy = spyEnv(env);
		const result = await deletePost(spy.env, {postId, actorId: authorId});
		expect(result.deleted).toBe(true);

		const counts = spy.getCounts();
		// Exactly one batch (the delete-time mutations) — pano_stats refresh
		// rides the same env afterward and is intentionally NOT atomic with
		// the delete (recomputable cache).
		expect(counts.batchCalls).toBe(1);
		expect(counts.batchStatementCounts[0]).toBe(3);
	});

	it("priorScore > 0: one batch with 4 statements (karma first, then post_vote + user_vote + post_summary)", async () => {
		const authorId = "atomic-del-nonzero-author";
		const voterId = "atomic-del-nonzero-voter";
		const {postId} = await seedPost({authorId});

		await voteOnPost(env, {postId, voterId});

		// Sanity: post_summary.score is now 1.
		const meta = (await env.PHOENIX_DB.prepare("SELECT score FROM post_summary WHERE id = ?")
			.bind(postId)
			.first()) as {score: number} | null;
		expect(meta!.score).toBe(1);

		const spy = spyEnv(env);
		const result = await deletePost(spy.env, {postId, actorId: authorId});
		expect(result.deleted).toBe(true);

		const counts = spy.getCounts();
		expect(counts.batchCalls).toBe(1);
		expect(counts.batchStatementCounts[0]).toBe(4);
	});

	it("recomputePanoStats still runs after the batch resolves (post + comment counts re-summed)", async () => {
		const authorId = "atomic-del-stats";
		const {postId} = await seedPost({authorId});

		const beforeStats = (await env.PHOENIX_DB.prepare(
			"SELECT total_posts FROM pano_stats WHERE id = 1",
		).first()) as {total_posts: number} | null;
		const beforeCount = beforeStats?.total_posts ?? 0;
		expect(beforeCount).toBeGreaterThanOrEqual(1);

		// Use the spy so we also confirm only one batch was issued.
		const spy = spyEnv(env);
		await deletePost(spy.env, {postId, actorId: authorId});
		expect(spy.getCounts().batchCalls).toBe(1);

		const afterStats = (await env.PHOENIX_DB.prepare(
			"SELECT total_posts FROM pano_stats WHERE id = 1",
		).first()) as {total_posts: number} | null;
		expect(afterStats!.total_posts).toBe(beforeCount - 1);
	});
});
