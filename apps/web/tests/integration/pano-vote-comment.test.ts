/**
 * `Pano.voteOnComment` / `Pano.retractCommentVote` — Effect service surface
 * (effect-migration task 5). Delegates to `Vote.cast` under the hood;
 * `CommentNotFound` translation preserves the wire code on a race.
 */
import {env} from "cloudflare:workers";
import {Cause, Effect, Exit, Layer} from "effect";
import {beforeAll, describe, expect, it} from "vitest";
import baselineMigration from "../../worker/db/drizzle/migrations/0000_d1_baseline.sql";
import {
	type AddCommentInput,
	Pano,
	PanoLive,
	type SubmitPostInput,
	type VoteOnCommentInput,
} from "../../worker/features/pano/Pano";
import {VoteLive} from "../../worker/features/vote/Vote";
import {CloudflareEnv, DrizzleLive} from "../../worker/services";

declare module "cloudflare:test" {
	// biome-ignore lint/suspicious/noEmptyBlockStatements: required by pool-workers
	interface ProvidedEnv extends Env {}
}

const TestLive = PanoLive.pipe(
	Layer.provideMerge(VoteLive),
	Layer.provide(DrizzleLive),
	Layer.provide(Layer.succeed(CloudflareEnv, env)),
);

function submitPost(input: SubmitPostInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.submitPost(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function addComment(input: AddCommentInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.addComment(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function voteOnComment(input: VoteOnCommentInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.voteOnComment(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

function retractCommentVote(input: VoteOnCommentInput) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const pano = yield* Pano;
			return yield* pano.retractCommentVote(input);
		}).pipe(Effect.provide(TestLive)),
	);
}

async function expectFailureTag(
	program: Effect.Effect<unknown, unknown, never>,
	tag: string,
): Promise<void> {
	const exit = await Effect.runPromise(Effect.exit(program));
	if (Exit.isSuccess(exit)) throw new Error("expected failure");
	const found = Cause.findError(exit.cause);
	if (found._tag !== "Success") throw new Error("expected typed failure");
	const err = found.success as {_tag?: string};
	expect(err._tag).toBe(tag);
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

async function seedPostAndComment(opts: {
	postAuthorId: string;
	commentAuthorId: string;
	commentBody?: string;
}) {
	await seedProfile(opts.postAuthorId);
	await seedProfile(opts.commentAuthorId);
	const post = await submitPost({
		title: `vote-on-comment seed ${opts.postAuthorId}`,
		tags: [{kind: "tartışma"}],
		authorId: opts.postAuthorId,
		authorName: "post author",
	});
	const comment = await addComment({
		postId: post.postId,
		authorId: opts.commentAuthorId,
		authorName: "comment author",
		body: opts.commentBody ?? "a comment to vote on",
	});
	return {postId: post.postId, commentId: comment.commentId};
}

beforeAll(async () => {
	await applyViewMigrations();
});

describe("Pano.voteOnComment", () => {
	it("casts a vote, recomputes comment.score, writes user_vote + karma + comment_view", async () => {
		const postAuthorId = "p-author-cv-1";
		const commentAuthorId = "c-author-cv-1";
		const voterId = "voter-cv-1";
		const {commentId} = await seedPostAndComment({postAuthorId, commentAuthorId});

		const result = await voteOnComment({commentId, voterId});
		expect(result.score).toBe(1);
		expect(result.changed).toBe(true);
		expect(result.myVote).toBe(1);
		expect(result.commentId).toBe(commentId);

		const vote = await env.PHOENIX_DB.prepare(
			"SELECT voter_id FROM comment_vote WHERE comment_id = ? AND voter_id = ?",
		)
			.bind(commentId, voterId)
			.first();
		expect(vote).not.toBeNull();

		const voteRow = await env.PHOENIX_DB.prepare(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_kind = 'comment' AND target_id = ?",
		)
			.bind(voterId, commentId)
			.first();
		expect(voteRow).not.toBeNull();

		const view = await env.PHOENIX_DB.prepare("SELECT score FROM comment_view WHERE id = ?")
			.bind(commentId)
			.first<{score: number}>();
		expect(view!.score).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("two consecutive votes from the same user are idempotent (score stays at 1)", async () => {
		const commentAuthorId = "c-author-cv-idem";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "p-author-cv-idem",
			commentAuthorId,
		});
		const voterId = "voter-cv-idem";

		const first = await voteOnComment({commentId, voterId});
		expect(first.score).toBe(1);
		expect(first.changed).toBe(true);

		const second = await voteOnComment({commentId, voterId});
		expect(second.score).toBe(1);
		expect(second.changed).toBe(false);
		expect(second.myVote).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);

		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM comment_vote WHERE comment_id = ? AND voter_id = ?",
		)
			.bind(commentId, voterId)
			.first<{n: number}>();
		expect(count!.n).toBe(1);
	});

	it("retractCommentVote removes the row, recomputes score, removes user_vote + decrements karma", async () => {
		const commentAuthorId = "c-author-cv-retract";
		const voterId = "voter-cv-retract";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "p-author-cv-retract",
			commentAuthorId,
		});

		await voteOnComment({commentId, voterId});

		const retract = await retractCommentVote({commentId, voterId});
		expect(retract.score).toBe(0);
		expect(retract.changed).toBe(true);
		expect(retract.myVote).toBeNull();

		const view = await env.PHOENIX_DB.prepare("SELECT score FROM comment_view WHERE id = ?")
			.bind(commentId)
			.first<{score: number}>();
		expect(view!.score).toBe(0);

		const userVote = await env.PHOENIX_DB.prepare(
			"SELECT user_id FROM user_vote WHERE user_id = ? AND target_id = ?",
		)
			.bind(voterId, commentId)
			.first();
		expect(userVote).toBeNull();

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(0);
	});

	it("retracting a vote that doesn't exist is a no-op", async () => {
		const {commentId} = await seedPostAndComment({
			postAuthorId: "p-author-cv-noop",
			commentAuthorId: "c-author-cv-noop",
		});

		const result = await retractCommentVote({commentId, voterId: "voter-cv-noop"});
		expect(result.score).toBe(0);
		expect(result.changed).toBe(false);
		expect(result.myVote).toBeNull();
	});

	it("vote → unvote → vote round-trip ends with score 1 and one comment_vote row", async () => {
		const commentAuthorId = "c-author-cv-rt";
		const voterId = "voter-cv-rt";
		const {commentId} = await seedPostAndComment({
			postAuthorId: "p-author-cv-rt",
			commentAuthorId,
		});

		await voteOnComment({commentId, voterId});
		await retractCommentVote({commentId, voterId});
		const final = await voteOnComment({commentId, voterId});
		expect(final.score).toBe(1);
		expect(final.changed).toBe(true);

		const count = await env.PHOENIX_DB.prepare(
			"SELECT COUNT(*) as n FROM comment_vote WHERE comment_id = ? AND voter_id = ?",
		)
			.bind(commentId, voterId)
			.first<{n: number}>();
		expect(count!.n).toBe(1);

		const profile = await env.PHOENIX_DB.prepare(
			"SELECT total_karma FROM user_profile WHERE user_id = ?",
		)
			.bind(commentAuthorId)
			.first<{total_karma: number}>();
		expect(profile!.total_karma).toBe(1);
	});

	it("voteOnComment on an unknown comment id rejects with CommentNotFound", async () => {
		await seedPostAndComment({
			postAuthorId: "p-author-cv-missing",
			commentAuthorId: "c-author-cv-missing",
		});
		await expectFailureTag(
			Effect.gen(function* () {
				const pano = yield* Pano;
				return yield* pano.voteOnComment({commentId: "comm_DOES_NOT_EXIST", voterId: "voter-x"});
			}).pipe(Effect.provide(TestLive)),
			"pano/CommentNotFound",
		);
	});
});
