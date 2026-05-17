/**
 * Vote module integration tests.
 *
 * Exercises the canonical `vote()` entry point at
 * `worker/features/vote/module.ts`. The module discriminates writes by
 * `targetKind: 'definition' | 'post' | 'comment'` and atomically updates:
 *   - the feature-local vote table (`definition_vote`, `post_vote`,
 *     `comment_vote`) — score truth source.
 *   - the cross-product `user_vote` table (PK `(userId, targetKind,
 *     targetId)`) — powers `myVote`.
 *   - the target row's score / counter cache (`definition_view.score`, etc).
 *   - the target author's `user_profile.total_karma`.
 *
 * Idempotency is exercised against the `user_vote` PK + the feature-local
 * vote-table PK: re-casting the same value is a no-op; retracting when
 * nothing is set is a no-op; flipping (cast → retract → cast) round-trips
 * to a single row.
 *
 * The first describe block covers `targetKind: 'definition'`; the post
 * and comment kinds are exercised in their own describe blocks below.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:test";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {addComment, submitPost} from "../../worker/features/pano/module";
import {addDefinition} from "../../worker/features/sozluk/module";
import {vote, VoteTargetNotFoundError} from "../../worker/features/vote/module";

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

async function seedDefinition(slug: string, authorId: string) {
	const result = await addDefinition(env, {
		termSlug: slug,
			authorId,
		authorName: "umut",
		body: `seed for ${slug}`,
	});
	return result.definitionId;
}

async function seedPost(authorId: string) {
	const result = await submitPost(env, {
		title: `vote-mod post ${Math.random().toString(36).slice(2)}`,
		tags: [{kind: "tartışma"}],
		authorId,
		authorName: "umut",
	});
	return result.postId;
}

async function seedPostAndComment(postAuthorId: string, commentAuthorId: string) {
	const postId = await seedPost(postAuthorId);
	const comment = await addComment(env, {
		postId,
		authorId: commentAuthorId,
		authorName: "comment author",
		body: "seed comment",
	});
	return {postId, commentId: comment.commentId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("vote module — targetKind: 'definition'", () => {
	it("casts a definition vote: score 0 → 1, user_vote row written, karma bumped", async () => {
		const definitionId = await seedDefinition("vote-mod-cast", "author-cast");

		const result = await vote(env, {
			userId: "voter-cast",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);
		expect(result.myVote).toBe(1);

		const def = await env.PHOENIX_DB.prepare(
			"SELECT score FROM definition_view WHERE id = ?",
		)
			.bind(definitionId)
			.first<{score: number}>();
		expect(def!.score).toBe(1);

		// user_vote PK row present.
		const uv = await env.PHOENIX_DB.prepare(
			"SELECT 1 as ok FROM user_vote WHERE user_id = ? AND target_kind = ? AND target_id = ?",
		)
			.bind("voter-cast", "definition", definitionId)
			.first();
		expect(uv).not.toBeNull();

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind("author-cast")
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("re-casting the same value is an idempotent no-op", async () => {
		const definitionId = await seedDefinition("vote-mod-recast", "author-recast");

		const first = await vote(env, {
			userId: "voter-recast",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		expect(first.changed).toBe(true);
		expect(first.score).toBe(1);

		const second = await vote(env, {
			userId: "voter-recast",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		expect(second.changed).toBe(false);
		expect(second.score).toBe(1);
		expect(second.myVote).toBe(1);

		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ? AND voter_id = ?",
		)
			.bind(definitionId, "voter-recast")
			.first<{n: number}>();
		expect(count!.n).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind("author-recast")
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("flips cast → retract: row deleted, score back to 0, karma decremented", async () => {
		const definitionId = await seedDefinition("vote-mod-flip", "author-flip");

		await vote(env, {
			userId: "voter-flip",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});

		const retracted = await vote(env, {
			userId: "voter-flip",
			targetKind: "definition",
			targetId: definitionId,
			value: null,
		});
		expect(retracted.changed).toBe(true);
		expect(retracted.score).toBe(0);
		expect(retracted.myVote).toBe(null);

		const dvCount = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ? AND voter_id = ?",
		)
			.bind(definitionId, "voter-flip")
			.first<{n: number}>();
		expect(dvCount!.n).toBe(0);

		const uvCount = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_kind = 'definition' AND target_id = ?",
		)
			.bind("voter-flip", definitionId)
			.first<{n: number}>();
		expect(uvCount!.n).toBe(0);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind("author-flip")
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(0);
	});

	it("retracting when no vote exists is a no-op", async () => {
		const definitionId = await seedDefinition("vote-mod-retract-noop", "author-rnoop");

		const result = await vote(env, {
			userId: "voter-rnoop",
			targetKind: "definition",
			targetId: definitionId,
			value: null,
		});
		expect(result.changed).toBe(false);
		expect(result.score).toBe(0);
		expect(result.myVote).toBe(null);
	});

	it("cast → retract → cast round-trip ends at score 1, one row, karma 1", async () => {
		const definitionId = await seedDefinition("vote-mod-rt", "author-rt");

		await vote(env, {
			userId: "voter-rt",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		await vote(env, {
			userId: "voter-rt",
			targetKind: "definition",
			targetId: definitionId,
			value: null,
		});
		const final = await vote(env, {
			userId: "voter-rt",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		expect(final.score).toBe(1);
		expect(final.myVote).toBe(1);

		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ?",
		)
			.bind(definitionId)
			.first<{n: number}>();
		expect(count!.n).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind("author-rt")
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("voting on an unknown definition rejects with VoteTargetNotFoundError", async () => {
		await expect(
			vote(env, {
				userId: "voter-x",
				targetKind: "definition",
				targetId: "def_NEVER_EXISTS",
				value: 1,
			}),
		).rejects.toBeInstanceOf(VoteTargetNotFoundError);
	});
});

describe("vote module — targetKind: 'post'", () => {
	it("casts a post vote: score 0 → 1, post_summary + post_vote + user_vote written, karma bumped", async () => {
		const authorId = "vm-post-author-cast";
		const postId = await seedPost(authorId);

		const result = await vote(env, {
			userId: "vm-post-voter-cast",
			targetKind: "post",
			targetId: postId,
			value: 1,
		});
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);
		expect(result.myVote).toBe(1);

		// post_summary.score updated.
		const summary = await env.PHOENIX_DB.prepare(
			"SELECT score, hot_score FROM post_summary WHERE id = ?",
		)
			.bind(postId)
			.first<{score: number; hot_score: number}>();
		expect(summary!.score).toBe(1);
		expect(summary!.hot_score).toBeGreaterThan(0);

		// post_vote row exists.
		const pv = await env.PHOENIX_DB.prepare(
			"SELECT 1 as ok FROM post_vote WHERE post_id = ? AND voter_id = ?",
		)
			.bind(postId, "vm-post-voter-cast")
			.first();
		expect(pv).not.toBeNull();

		// user_vote PK row present.
		const uv = await env.PHOENIX_DB.prepare(
			"SELECT 1 as ok FROM user_vote WHERE user_id = ? AND target_kind = 'post' AND target_id = ?",
		)
			.bind("vm-post-voter-cast", postId)
			.first();
		expect(uv).not.toBeNull();

		// karma 0 → 1 for the post author.
		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("re-casting a post vote is an idempotent no-op", async () => {
		const authorId = "vm-post-author-recast";
		const postId = await seedPost(authorId);

		const first = await vote(env, {
			userId: "vm-post-voter-recast",
			targetKind: "post",
			targetId: postId,
			value: 1,
		});
		expect(first.changed).toBe(true);

		const second = await vote(env, {
			userId: "vm-post-voter-recast",
			targetKind: "post",
			targetId: postId,
			value: 1,
		});
		expect(second.changed).toBe(false);
		expect(second.score).toBe(1);
		expect(second.myVote).toBe(1);

		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM post_vote WHERE post_id = ? AND voter_id = ?",
		)
			.bind(postId, "vm-post-voter-recast")
			.first<{n: number}>();
		expect(count!.n).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("flips cast → retract on a post: row deleted, score 0, karma decremented", async () => {
		const authorId = "vm-post-author-flip";
		const postId = await seedPost(authorId);

		await vote(env, {
			userId: "vm-post-voter-flip",
			targetKind: "post",
			targetId: postId,
			value: 1,
		});

		const retracted = await vote(env, {
			userId: "vm-post-voter-flip",
			targetKind: "post",
			targetId: postId,
			value: null,
		});
		expect(retracted.changed).toBe(true);
		expect(retracted.score).toBe(0);
		expect(retracted.myVote).toBe(null);

		const pvCount = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM post_vote WHERE post_id = ? AND voter_id = ?",
		)
			.bind(postId, "vm-post-voter-flip")
			.first<{n: number}>();
		expect(pvCount!.n).toBe(0);

		const uvCount = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_kind = 'post' AND target_id = ?",
		)
			.bind("vm-post-voter-flip", postId)
			.first<{n: number}>();
		expect(uvCount!.n).toBe(0);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(0);
	});

	it("retracting a post vote when none exists is a no-op", async () => {
		const postId = await seedPost("vm-post-author-rnoop");

		const result = await vote(env, {
			userId: "vm-post-voter-rnoop",
			targetKind: "post",
			targetId: postId,
			value: null,
		});
		expect(result.changed).toBe(false);
		expect(result.score).toBe(0);
		expect(result.myVote).toBe(null);
	});

	it("post cast → retract → cast round-trip ends at score 1, one row, karma 1", async () => {
		const authorId = "vm-post-author-rt";
		const postId = await seedPost(authorId);

		await vote(env, {
			userId: "vm-post-voter-rt",
			targetKind: "post",
			targetId: postId,
			value: 1,
		});
		await vote(env, {
			userId: "vm-post-voter-rt",
			targetKind: "post",
			targetId: postId,
			value: null,
		});
		const final = await vote(env, {
			userId: "vm-post-voter-rt",
			targetKind: "post",
			targetId: postId,
			value: 1,
		});
		expect(final.score).toBe(1);
		expect(final.myVote).toBe(1);

		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM post_vote WHERE post_id = ?",
		)
			.bind(postId)
			.first<{n: number}>();
		expect(count!.n).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("voting on an unknown post rejects with VoteTargetNotFoundError", async () => {
		await expect(
			vote(env, {
				userId: "vm-post-voter-x",
				targetKind: "post",
				targetId: "post_NEVER_EXISTS",
				value: 1,
			}),
		).rejects.toBeInstanceOf(VoteTargetNotFoundError);
	});
});

describe("vote module — targetKind: 'comment'", () => {
	it("casts a comment vote: score 0 → 1, comment_view + comment_vote + user_vote written, karma bumped on COMMENT author", async () => {
		const postAuthorId = "vm-comm-pauthor-cast";
		const commentAuthorId = "vm-comm-cauthor-cast";
		const {commentId} = await seedPostAndComment(postAuthorId, commentAuthorId);

		const result = await vote(env, {
			userId: "vm-comm-voter-cast",
			targetKind: "comment",
			targetId: commentId,
			value: 1,
		});
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);
		expect(result.myVote).toBe(1);

		const view = await env.PHOENIX_DB.prepare("SELECT score FROM comment_view WHERE id = ?")
			.bind(commentId)
			.first<{score: number}>();
		expect(view!.score).toBe(1);

		const cv = await env.PHOENIX_DB.prepare(
			"SELECT 1 as ok FROM comment_vote WHERE comment_id = ? AND voter_id = ?",
		)
			.bind(commentId, "vm-comm-voter-cast")
			.first();
		expect(cv).not.toBeNull();

		const uv = await env.PHOENIX_DB.prepare(
			"SELECT 1 as ok FROM user_vote WHERE user_id = ? AND target_kind = 'comment' AND target_id = ?",
		)
			.bind("vm-comm-voter-cast", commentId)
			.first();
		expect(uv).not.toBeNull();

		// karma 0 → 1 on the COMMENT author (not the post author).
		const commentAuthorProfile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(commentAuthorProfile!.total_karma).toBe(1);
	});

	it("re-casting a comment vote is an idempotent no-op", async () => {
		const commentAuthorId = "vm-comm-cauthor-recast";
		const {commentId} = await seedPostAndComment(
			"vm-comm-pauthor-recast",
			commentAuthorId,
		);

		const first = await vote(env, {
			userId: "vm-comm-voter-recast",
			targetKind: "comment",
			targetId: commentId,
			value: 1,
		});
		expect(first.changed).toBe(true);

		const second = await vote(env, {
			userId: "vm-comm-voter-recast",
			targetKind: "comment",
			targetId: commentId,
			value: 1,
		});
		expect(second.changed).toBe(false);
		expect(second.score).toBe(1);
		expect(second.myVote).toBe(1);

		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM comment_vote WHERE comment_id = ? AND voter_id = ?",
		)
			.bind(commentId, "vm-comm-voter-recast")
			.first<{n: number}>();
		expect(count!.n).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("flips cast → retract on a comment: row deleted, score 0, karma decremented", async () => {
		const commentAuthorId = "vm-comm-cauthor-flip";
		const {commentId} = await seedPostAndComment(
			"vm-comm-pauthor-flip",
			commentAuthorId,
		);

		await vote(env, {
			userId: "vm-comm-voter-flip",
			targetKind: "comment",
			targetId: commentId,
			value: 1,
		});

		const retracted = await vote(env, {
			userId: "vm-comm-voter-flip",
			targetKind: "comment",
			targetId: commentId,
			value: null,
		});
		expect(retracted.changed).toBe(true);
		expect(retracted.score).toBe(0);
		expect(retracted.myVote).toBe(null);

		const cvCount = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM comment_vote WHERE comment_id = ? AND voter_id = ?",
		)
			.bind(commentId, "vm-comm-voter-flip")
			.first<{n: number}>();
		expect(cvCount!.n).toBe(0);

		const uvCount = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_kind = 'comment' AND target_id = ?",
		)
			.bind("vm-comm-voter-flip", commentId)
			.first<{n: number}>();
		expect(uvCount!.n).toBe(0);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(0);
	});

	it("retracting a comment vote when none exists is a no-op", async () => {
		const {commentId} = await seedPostAndComment(
			"vm-comm-pauthor-rnoop",
			"vm-comm-cauthor-rnoop",
		);

		const result = await vote(env, {
			userId: "vm-comm-voter-rnoop",
			targetKind: "comment",
			targetId: commentId,
			value: null,
		});
		expect(result.changed).toBe(false);
		expect(result.score).toBe(0);
		expect(result.myVote).toBe(null);
	});

	it("comment cast → retract → cast round-trip ends at score 1, one row, karma 1", async () => {
		const commentAuthorId = "vm-comm-cauthor-rt";
		const {commentId} = await seedPostAndComment("vm-comm-pauthor-rt", commentAuthorId);

		await vote(env, {
			userId: "vm-comm-voter-rt",
			targetKind: "comment",
			targetId: commentId,
			value: 1,
		});
		await vote(env, {
			userId: "vm-comm-voter-rt",
			targetKind: "comment",
			targetId: commentId,
			value: null,
		});
		const final = await vote(env, {
			userId: "vm-comm-voter-rt",
			targetKind: "comment",
			targetId: commentId,
			value: 1,
		});
		expect(final.score).toBe(1);
		expect(final.myVote).toBe(1);

		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM comment_vote WHERE comment_id = ?",
		)
			.bind(commentId)
			.first<{n: number}>();
		expect(count!.n).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("voting on an unknown comment rejects with VoteTargetNotFoundError", async () => {
		await expect(
			vote(env, {
				userId: "vm-comm-voter-x",
				targetKind: "comment",
				targetId: "comm_NEVER_EXISTS",
				value: 1,
			}),
		).rejects.toBeInstanceOf(VoteTargetNotFoundError);
	});
});

/**
 * Atomicity invariant.
 *
 * A state-changing `vote()` call must collapse every mutation — the
 * feature-local vote table, the cross-product `user_vote` row, the
 * target-row score cache, and the karma counter — into one
 * `env.PHOENIX_DB.batch([...])` call. No standalone `.prepare(...).run()`
 * may precede the batch on the mutation path. Idempotent re-casts /
 * re-retracts never call `batch`.
 */
describe("vote module — atomic single-batch write", () => {
	/**
	 * Wraps `env` so callers can spy on `PHOENIX_DB.batch` and the
	 * `.prepare(sql).bind(...).run()` chain without losing the real D1 binding's
	 * behaviour. `.prepare(sql)` still returns a real `D1PreparedStatement` —
	 * we only intercept `.run()` and `.bind()` (to keep the wrapper covering
	 * the bound copy); everything else (`.first`, `.all`, `.raw`) goes straight
	 * through.
	 *
	 * Returns `{env, getCounts}` so tests can introspect the counters
	 * post-call without leaking implementation detail into the test body.
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
							const bound = (orig as (...a: unknown[]) => D1PreparedStatement).apply(
								target,
								args,
							);
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

	it("definition cast: one batch (vote-table + user_vote + score cache + karma), zero standalone .run()", async () => {
		const definitionId = await seedDefinition("vote-mod-atomic-def", "author-atomic-def");
		const spy = spyEnv(env);

		const result = await vote(spy.env, {
			userId: "voter-atomic-def",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		expect(result.changed).toBe(true);
		expect(result.score).toBe(1);

		const counts = spy.getCounts();
		expect(counts.batchCalls).toBe(1);
		expect(counts.runCalls).toBe(0);
		// vote-table insert + score cache (1 stmt) + user_vote insert + karma upsert = 4.
		expect(counts.batchStatementCounts[0]).toBe(4);
	});

	it("post cast: one batch with 4 statements, zero standalone .run()", async () => {
		const postId = await seedPost("vm-post-author-atomic");
		const spy = spyEnv(env);

		const result = await vote(spy.env, {
			userId: "vm-post-voter-atomic",
			targetKind: "post",
			targetId: postId,
			value: 1,
		});
		expect(result.changed).toBe(true);

		const counts = spy.getCounts();
		expect(counts.batchCalls).toBe(1);
		expect(counts.runCalls).toBe(0);
		expect(counts.batchStatementCounts[0]).toBe(4);
	});

	it("comment cast: one batch with 4 statements, zero standalone .run()", async () => {
		const {commentId} = await seedPostAndComment(
			"vm-comm-pauthor-atomic",
			"vm-comm-cauthor-atomic",
		);
		const spy = spyEnv(env);

		const result = await vote(spy.env, {
			userId: "vm-comm-voter-atomic",
			targetKind: "comment",
			targetId: commentId,
			value: 1,
		});
		expect(result.changed).toBe(true);

		const counts = spy.getCounts();
		expect(counts.batchCalls).toBe(1);
		expect(counts.runCalls).toBe(0);
		expect(counts.batchStatementCounts[0]).toBe(4);
	});

	it("retract: one batch (vote-table delete + user_vote delete + score cache + karma decrement)", async () => {
		const definitionId = await seedDefinition("vote-mod-atomic-retract", "author-atomic-r");
		// Seed a cast first (outside the spy so only the retract is measured).
		await vote(env, {
			userId: "voter-atomic-retract",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});

		const spy = spyEnv(env);
		const result = await vote(spy.env, {
			userId: "voter-atomic-retract",
			targetKind: "definition",
			targetId: definitionId,
			value: null,
		});
		expect(result.changed).toBe(true);
		expect(result.score).toBe(0);

		const counts = spy.getCounts();
		expect(counts.batchCalls).toBe(1);
		expect(counts.runCalls).toBe(0);
		expect(counts.batchStatementCounts[0]).toBe(4);
	});

	it("idempotent re-cast: no batch, no .run() (early-return path)", async () => {
		const definitionId = await seedDefinition("vote-mod-atomic-noop", "author-atomic-noop");
		await vote(env, {
			userId: "voter-atomic-noop",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});

		const spy = spyEnv(env);
		const result = await vote(spy.env, {
			userId: "voter-atomic-noop",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		expect(result.changed).toBe(false);

		const counts = spy.getCounts();
		expect(counts.batchCalls).toBe(0);
		expect(counts.runCalls).toBe(0);
	});

	it("score cache equals COUNT(*) on the truth table after a state change (truth-derived, self-healing under INSERT OR IGNORE races)", async () => {
		const definitionId = await seedDefinition("vote-mod-truth", "author-truth");

		await vote(env, {
			userId: "voter-truth-a",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});
		await vote(env, {
			userId: "voter-truth-b",
			targetKind: "definition",
			targetId: definitionId,
			value: 1,
		});

		const truth = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ?",
		)
			.bind(definitionId)
			.first<{n: number}>();
		const cached = await env.PHOENIX_DB.prepare(
			"SELECT score FROM definition_view WHERE id = ?",
		)
			.bind(definitionId)
			.first<{score: number}>();

		expect(cached?.score).toBe(truth?.n);
		expect(cached?.score).toBe(2);
	});
});
