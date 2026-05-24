/**
 * Vote service integration tests — effect-migration task 3.
 *
 * Exercises the `Vote` `Context.Service` end-to-end inside workerd with the
 * real D1 binding. Covers the four contracts the task spec calls out:
 *
 *   1. Round-trip — vote on a definition then retract → score returns to its
 *      starting value (0).
 *   2. Idempotency — voting on a post twice with the same `value` is a no-op
 *      on the second call (same row count, same `created_at`).
 *   3. Not-found — voting on a non-existent comment fails with
 *      `VoteTargetNotFound` in the typed `E` channel.
 *   4. Atomicity — when the karma bump statement would fail, the vote insert
 *      rolls back too (both happen or neither).
 *
 * Layer setup: `VoteLive` + `DrizzleLive` + `CloudflareEnv(miniflareEnv)`,
 * mirroring the Pasaport integration test idiom. No mocks — real D1 under
 * the layer pipeline.
 */
/// <reference path="../../worker-configuration.d.ts" />
/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import {env} from "cloudflare:workers";
import {Cause, Effect, Exit, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {Pano, PanoLive} from "../../worker/features/pano/Pano";
import {Sozluk, SozlukLive} from "../../worker/features/sozluk/Sozluk";
import {VoteTargetNotFound} from "../../worker/features/vote/errors";
import {Vote, VoteLive} from "../../worker/features/vote/Vote";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = Layer.mergeAll(SozlukLive, PanoLive).pipe(
	Layer.provideMerge(VoteLive),
	Layer.provide(DrizzleLive),
	Layer.provide(Layer.succeed(CloudflareEnv, env)),
);

async function submitPostEff(input: {
	title: string;
	tags: Array<{kind: string}>;
	authorId: string;
	authorName: string;
}) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.submitPost(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

async function addCommentEff(input: {
	postId: string;
	authorId: string;
	authorName: string;
	body: string;
}) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.addComment(input);
		}).pipe(Effect.provide(TestLive)),
	);
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
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const sozluk = yield* Sozluk;
			return yield* sozluk.addDefinition({
				termSlug: slug,
				authorId,
				authorName: "umut",
				body: `seed for ${slug}`,
			});
		}).pipe(Effect.provide(TestLive)),
	);
	return result.definitionId;
}

async function seedPost(authorId: string) {
	const result = await submitPostEff({
		title: `vote-svc post ${Math.random().toString(36).slice(2)}`,
		tags: [{kind: "tartışma"}],
		authorId,
		authorName: "umut",
	});
	return result.postId;
}

async function seedPostAndComment(postAuthorId: string, commentAuthorId: string) {
	const postId = await seedPost(postAuthorId);
	const comment = await addCommentEff({
		postId,
		authorId: commentAuthorId,
		authorName: "comment author",
		body: "seed comment",
	});
	return {postId, commentId: comment.commentId};
}

/**
 * Seed an empty `user_profile` row so `karmaBumpStatement` (a plain UPDATE,
 * by design) lands on an existing row. The legacy `vote()` module did an
 * upsert-with-defaults; the new `Vote` service composes the pure karma
 * statement from `pasaport/karma.ts` and trusts profiles already exist (the
 * production write path goes through `Pasaport.setUsername` → user_profile
 * upsert before any vote can be cast).
 */
async function seedProfile(userId: string) {
	const now = Math.floor(Date.now() / 1000);
	await env.PHOENIX_DB.prepare(
		`INSERT INTO user_profile (
			user_id, username, display_name, image,
			total_karma, definition_count, post_count, comment_count,
			updated_at, last_event_id
		) VALUES (?, NULL, NULL, NULL, 0, 0, 0, 0, ?, '')
		ON CONFLICT(user_id) DO NOTHING`,
	)
		.bind(userId, now)
		.run();
}

const castVote = (input: {
	userId: string;
	targetKind: "definition" | "post" | "comment";
	targetId: string;
	value: 1 | null;
}) =>
	Effect.gen(function* () {
		const vote = yield* Vote;
		return yield* vote.cast(input);
	}).pipe(Effect.provide(TestLive));

beforeAll(async () => {
	await applyViewMigrations();
});

/* -------------------------------------------------------------------------- */
/* 1. Round-trip                                                               */
/* -------------------------------------------------------------------------- */

describe("Vote.cast — round-trip on a definition", () => {
	it("vote then retract restores score to the starting value", async () => {
		const authorId = "vs-rt-def-author";
		const voterId = "vs-rt-def-voter";
		await seedProfile(authorId);
		const definitionId = await seedDefinition("vs-rt-def", authorId);

		const cast = await Effect.runPromise(
			castVote({userId: voterId, targetKind: "definition", targetId: definitionId, value: 1}),
		);
		expect(cast.score).toBe(1);
		expect(cast.changed).toBe(true);
		expect(cast.myVote).toBe(1);

		const retract = await Effect.runPromise(
			castVote({userId: voterId, targetKind: "definition", targetId: definitionId, value: null}),
		);
		expect(retract.score).toBe(0);
		expect(retract.changed).toBe(true);
		expect(retract.myVote).toBeNull();

		// definition_vote truth source empty after retract.
		const truth = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ?",
		)
			.bind(definitionId)
			.first<{n: number}>();
		expect(truth!.n).toBe(0);

		// user_vote mirror cleared.
		const uv = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
		)
			.bind(voterId, definitionId)
			.first<{n: number}>();
		expect(uv!.n).toBe(0);

		// Karma bumped +1 then -1 = back to 0.
		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */
/* 2. Idempotency                                                              */
/* -------------------------------------------------------------------------- */

describe("Vote.cast — idempotency on a post", () => {
	it("voting twice with the same value is a no-op (row count + timestamp unchanged)", async () => {
		const authorId = "vs-idem-post-author";
		const voterId = "vs-idem-post-voter";
		await seedProfile(authorId);
		const postId = await seedPost(authorId);

		const first = await Effect.runPromise(
			castVote({userId: voterId, targetKind: "post", targetId: postId, value: 1}),
		);
		expect(first.changed).toBe(true);
		expect(first.score).toBe(1);

		// Capture the post_vote row's created_at + the user_vote mirror's
		// created_at before the second call. Both must be unchanged when the
		// second call is an idempotent no-op (no batch issued).
		const beforeRow = await env.PHOENIX_DB.prepare(
			"SELECT created_at FROM post_vote WHERE post_id = ? AND voter_id = ?",
		)
			.bind(postId, voterId)
			.first<{created_at: number}>();
		const beforeMirror = await env.PHOENIX_DB.prepare(
			"SELECT created_at FROM user_vote WHERE user_id = ? AND target_kind = 'post' AND target_id = ?",
		)
			.bind(voterId, postId)
			.first<{created_at: number}>();
		expect(beforeRow).not.toBeNull();
		expect(beforeMirror).not.toBeNull();

		// Force at least one millisecond of drift so any unintended write
		// would change the second-resolution timestamp.
		await new Promise((r) => setTimeout(r, 1100));

		const second = await Effect.runPromise(
			castVote({userId: voterId, targetKind: "post", targetId: postId, value: 1}),
		);
		expect(second.changed).toBe(false);
		expect(second.score).toBe(1);
		expect(second.myVote).toBe(1);

		// Exactly one post_vote row, same created_at.
		const after = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n, MAX(created_at) as ts FROM post_vote WHERE post_id = ? AND voter_id = ?",
		)
			.bind(postId, voterId)
			.first<{n: number; ts: number}>();
		expect(after!.n).toBe(1);
		expect(after!.ts).toBe(beforeRow!.created_at);

		// user_vote mirror's created_at also unchanged.
		const afterMirror = await env.PHOENIX_DB.prepare(
			"SELECT created_at FROM user_vote WHERE user_id = ? AND target_kind = 'post' AND target_id = ?",
		)
			.bind(voterId, postId)
			.first<{created_at: number}>();
		expect(afterMirror!.created_at).toBe(beforeMirror!.created_at);

		// Karma stays at exactly +1 (no double-bump).
		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(authorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});
});

/* -------------------------------------------------------------------------- */
/* 3. Not-found                                                                */
/* -------------------------------------------------------------------------- */

describe("Vote.cast — non-existent target", () => {
	it("voting on a non-existent comment fails with VoteTargetNotFound", async () => {
		const exit = await Effect.runPromise(
			Effect.exit(
				castVote({
					userId: "vs-nf-voter",
					targetKind: "comment",
					targetId: "comm_NEVER_EXISTS",
					value: 1,
				}),
			),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isSuccess(exit)) return;
		const found = Cause.findError(exit.cause);
		expect(found._tag).toBe("Success");
		if (found._tag !== "Success") return;
		const err = found.success;
		expect(err).toBeInstanceOf(VoteTargetNotFound);
		expect((err as VoteTargetNotFound)._tag).toBe("vote/VoteTargetNotFound");
		expect((err as VoteTargetNotFound).targetKind).toBe("comment");
		expect((err as VoteTargetNotFound).targetId).toBe("comm_NEVER_EXISTS");
	});

	it("voting on a non-existent definition fails with VoteTargetNotFound", async () => {
		const exit = await Effect.runPromise(
			Effect.exit(
				castVote({
					userId: "vs-nf-voter-def",
					targetKind: "definition",
					targetId: "def_NEVER_EXISTS",
					value: 1,
				}),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isSuccess(exit)) return;
		const found = Cause.findError(exit.cause);
		expect(found._tag).toBe("Success");
		if (found._tag !== "Success") return;
		expect((found.success as VoteTargetNotFound).targetKind).toBe("definition");
	});

	it("voting on a non-existent post fails with VoteTargetNotFound", async () => {
		const exit = await Effect.runPromise(
			Effect.exit(
				castVote({
					userId: "vs-nf-voter-post",
					targetKind: "post",
					targetId: "post_NEVER_EXISTS",
					value: 1,
				}),
			),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isSuccess(exit)) return;
		const found = Cause.findError(exit.cause);
		expect(found._tag).toBe("Success");
		if (found._tag !== "Success") return;
		expect((found.success as VoteTargetNotFound).targetKind).toBe("post");
	});
});

/* -------------------------------------------------------------------------- */
/* 4. Atomicity — karma + vote insert succeed together or roll back together   */
/* -------------------------------------------------------------------------- */

describe("Vote.cast — atomic batch", () => {
	it("comment vote also bumps karma in the same batch (round-trip nets to zero)", async () => {
		const postAuthorId = "vs-atom-post-author";
		const commentAuthorId = "vs-atom-comment-author";
		const voterId = "vs-atom-voter";
		await seedProfile(commentAuthorId);
		const {commentId} = await seedPostAndComment(postAuthorId, commentAuthorId);

		await Effect.runPromise(
			castVote({userId: voterId, targetKind: "comment", targetId: commentId, value: 1}),
		);
		const afterCast = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(afterCast!.total_karma).toBe(1);

		// comment_vote row + user_vote mirror both written in the same batch.
		const cv = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM comment_vote WHERE comment_id = ? AND voter_id = ?",
		)
			.bind(commentId, voterId)
			.first<{n: number}>();
		expect(cv!.n).toBe(1);
		const uv = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_kind = 'comment' AND target_id = ?",
		)
			.bind(voterId, commentId)
			.first<{n: number}>();
		expect(uv!.n).toBe(1);

		// Retract — same atomic guarantee in reverse.
		await Effect.runPromise(
			castVote({userId: voterId, targetKind: "comment", targetId: commentId, value: null}),
		);
		const afterRetract = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(afterRetract!.total_karma).toBe(0);
		const cvAfter = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM comment_vote WHERE comment_id = ? AND voter_id = ?",
		)
			.bind(commentId, voterId)
			.first<{n: number}>();
		expect(cvAfter!.n).toBe(0);
	});

	it("rolls back the vote-table insert when the karma statement fails", async () => {
		// Drop `user_profile` so the karma statement inside the batch fails
		// (no such table). The vote-table insert and user_vote mirror must
		// roll back with it — verifiable by counting rows after.
		const authorId = "vs-atom-fail-author";
		await seedProfile(authorId);
		const definitionId = await seedDefinition("vs-atom-fail", authorId);
		const voterId = "vs-atom-fail-voter";

		// Sanity: pre-state.
		const before = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ?",
		)
			.bind(definitionId)
			.first<{n: number}>();
		expect(before!.n).toBe(0);

		// Rename user_profile mid-test to force the karma statement to fail.
		// SQLite supports `ALTER TABLE … RENAME TO`; the batch's karma UPDATE
		// targets `user_profile` by name, so this fails the batch.
		await env.PHOENIX_DB.prepare("ALTER TABLE user_profile RENAME TO user_profile_hidden").run();
		try {
			const exit = await Effect.runPromise(
				Effect.exit(
					castVote({
						userId: voterId,
						targetKind: "definition",
						targetId: definitionId,
						value: 1,
					}),
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);
		} finally {
			// Restore the table so subsequent tests can use it.
			await env.PHOENIX_DB.prepare("ALTER TABLE user_profile_hidden RENAME TO user_profile").run();
		}

		// The vote-table insert + user_vote mirror must have rolled back when
		// the karma statement failed. If atomicity is broken these would be 1.
		const after = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM definition_vote WHERE definition_id = ?",
		)
			.bind(definitionId)
			.first<{n: number}>();
		expect(after!.n).toBe(0);

		const uv = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM user_vote WHERE user_id = ? AND target_id = ?",
		)
			.bind(voterId, definitionId)
			.first<{n: number}>();
		expect(uv!.n).toBe(0);

		// Score cache untouched too.
		const view = await env.PHOENIX_DB.prepare("SELECT score FROM definition_view WHERE id = ?")
			.bind(definitionId)
			.first<{score: number}>();
		expect(view!.score).toBe(0);
	});
});
