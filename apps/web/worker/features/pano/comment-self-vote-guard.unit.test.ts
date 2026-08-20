/**
 * `Pano.applyCommentVote` self-vote guard (#2216, founder-ruled), proven over the real
 * `makeCommentOperations` closures with a substituted `Drizzle` `run` and a RECORDING
 * `Vote`: a self-cast is rejected and never reaches `Vote.cast`, a non-author cast
 * lands, and a self-RETRACT is exempt (the guard is cast-only — a blocked cast leaves
 * nothing to retract).
 */
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import {UserId} from "../../lib/ids.ts";
import type {Vote, VoteInput, VoteResult} from "../vote/Vote.ts";
import {type CommentOperationsDeps, makeCommentOperations} from "./comment-operations.ts";
import {CommentId} from "./ids.ts";

const AUTHOR = UserId.make("u-author");
const OTHER = UserId.make("u-other");
const COMMENT_ID = CommentId.make("comment_1");

// Only `authorId` drives the guard; the rest satisfy the return projection.
const commentRow = {
	id: COMMENT_ID,
	postId: "post_1",
	parentId: null,
	authorId: AUTHOR,
	authorName: "yazar",
	body: "yorum gövdesi",
	score: 2,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	removedAt: null,
};

// A `Vote` double that RECORDS every cast, so "did the cast path run" is observable
// with no engine. Every other method dies on contact via the Proxy.
const recordingVote = (casts: VoteInput[]): typeof Vote.Service =>
	new Proxy(
		{
			cast: (input: VoteInput) => {
				casts.push(input);
				return Effect.succeed({
					targetKind: input.targetKind,
					targetId: input.targetId,
					authorId: AUTHOR,
					score: commentRow.score,
					myVote: input.value,
					changed: false,
				} satisfies VoteResult);
			},
		} as Partial<typeof Vote.Service>,
		{
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () => Effect.die(`Vote.${String(prop)} not exercised in comment-self-vote-guard`);
			},
		},
	) as typeof Vote.Service;

// Only `run` (the comment load) + `voteSvc` are on the vote path; the other deps are
// captured but never invoked, so they die on contact if the guard falls through.
const deps = (voteSvc: typeof Vote.Service): CommentOperationsDeps =>
	({
		run: (<A>(_fn: unknown) => Effect.succeed(commentRow as A)) as DrizzleAccessOrDie["run"],
		voteSvc,
		reactionSvc: {} as CommentOperationsDeps["reactionSvc"],
		removalSeq: {} as CommentOperationsDeps["removalSeq"],
		persistPanoStats: (() => Effect.void) as CommentOperationsDeps["persistPanoStats"],
		readProfileIdentities: () => Effect.succeed([]),
	}) satisfies CommentOperationsDeps;

describe("Pano.applyCommentVote — the self-vote guard (#2216)", () => {
	it.effect("(1) a self-cast fails SelfVoteNotAllowed and never reaches Vote.cast", () =>
		Effect.gen(function* () {
			const casts: VoteInput[] = [];
			const ops = makeCommentOperations(deps(recordingVote(casts)));
			const exit = yield* Effect.exit(ops.voteOnComment({commentId: COMMENT_ID, voterId: AUTHOR}));
			assert.isTrue(Exit.isFailure(exit), "a self-cast is rejected");
			if (Exit.isFailure(exit)) {
				const error = Cause.findErrorOption(exit.cause);
				assert.isTrue(error._tag === "Some");
				if (error._tag === "Some") {
					assert.strictEqual((error.value as {_tag?: string})._tag, "vote/SelfVoteNotAllowed");
				}
			}
			assert.deepStrictEqual(casts, [], "Vote.cast is never reached on a self-cast");
		}),
	);

	it.effect("(2) a non-author cast reaches Vote.cast and lands", () =>
		Effect.gen(function* () {
			const casts: VoteInput[] = [];
			const ops = makeCommentOperations(deps(recordingVote(casts)));
			const result = yield* ops.voteOnComment({commentId: COMMENT_ID, voterId: OTHER});
			assert.deepStrictEqual(casts, [
				{userId: OTHER, targetKind: "comment", targetId: COMMENT_ID, value: true},
			]);
			assert.strictEqual(result.commentId, COMMENT_ID);
		}),
	);

	it.effect("(3) a self-RETRACT is exempt — it reaches Vote.cast (cast-only guard)", () =>
		Effect.gen(function* () {
			const casts: VoteInput[] = [];
			const ops = makeCommentOperations(deps(recordingVote(casts)));
			yield* ops.retractCommentVote({commentId: COMMENT_ID, voterId: AUTHOR});
			assert.deepStrictEqual(casts, [
				{userId: AUTHOR, targetKind: "comment", targetId: COMMENT_ID, value: false},
			]);
		}),
	);
});
