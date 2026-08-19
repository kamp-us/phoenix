/**
 * The cast-site self-vote guard (#2216), proven over the real `makePostOperations`
 * closures with a substituted `run` and a RECORDING `Vote` — no SQL engine. The guard
 * is cast-only: a self-RETRACT stays allowed, since a blocked cast leaves nothing to
 * retract.
 */
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import {UserId} from "../../lib/ids.ts";
import type {Vote, VoteInput, VoteResult} from "../vote/Vote.ts";
import {PostId} from "./ids.ts";
import {makePostOperations, type PostOperationsDeps} from "./post-operations.ts";

const AUTHOR = UserId.make("u-author");
const OTHER = UserId.make("u-other");
const POST_ID = PostId.make("post_1");

// Only `authorId` drives the guard; the rest satisfy the return projection's row shape.
const postRow = {
	id: POST_ID,
	slug: "post-1",
	title: "başlık",
	url: null,
	host: null,
	body: "gövde",
	bodyExcerpt: "gövde",
	authorId: AUTHOR,
	authorName: "yazar",
	score: 3,
	hotScore: 3,
	commentCount: 0,
	tags: "",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	removedAt: null,
	sandboxedAt: null,
	isDraft: null,
};

// Records every cast so "did the cast path run" is observable; every other method dies
// on contact through the Proxy, so an off-path call is loud.
const recordingVote = (casts: VoteInput[]): typeof Vote.Service =>
	new Proxy(
		{
			cast: (input: VoteInput) => {
				casts.push(input);
				return Effect.succeed({
					targetKind: input.targetKind,
					targetId: input.targetId,
					authorId: AUTHOR,
					score: postRow.score,
					myVote: input.value,
					changed: false,
				} satisfies VoteResult);
			},
		} as Partial<typeof Vote.Service>,
		{
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () => Effect.die(`Vote.${String(prop)} not exercised in self-vote-guard`);
			},
		},
	) as typeof Vote.Service;

// Only `run` and `voteSvc` are on the vote path; the rest die on contact if the guard
// ever falls through to them.
const deps = (voteSvc: typeof Vote.Service): PostOperationsDeps =>
	({
		run: (<A>(_fn: unknown) => Effect.succeed(postRow as A)) as DrizzleAccessOrDie["run"],
		batch: (() =>
			Effect.die("batch not exercised in self-vote-guard")) as DrizzleAccessOrDie["batch"],
		voteSvc,
		bookmarkSvc: {} as PostOperationsDeps["bookmarkSvc"],
		reactionSvc: {} as PostOperationsDeps["reactionSvc"],
		removalSeq: {} as PostOperationsDeps["removalSeq"],
		persistPanoStats: (() => Effect.void) as PostOperationsDeps["persistPanoStats"],
		readProfileIdentities: () => Effect.succeed([]),
	}) satisfies PostOperationsDeps;

describe("Pano.applyPostVote — the self-vote guard (#2216)", () => {
	it.effect("(1) a self-cast fails SelfVoteNotAllowed and never reaches Vote.cast", () =>
		Effect.gen(function* () {
			const casts: VoteInput[] = [];
			const ops = makePostOperations(deps(recordingVote(casts)));
			const exit = yield* Effect.exit(ops.voteOnPost({postId: POST_ID, voterId: AUTHOR}));
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
			const ops = makePostOperations(deps(recordingVote(casts)));
			const result = yield* ops.voteOnPost({postId: POST_ID, voterId: OTHER});
			assert.deepStrictEqual(casts, [
				{userId: OTHER, targetKind: "post", targetId: POST_ID, value: true},
			]);
			assert.strictEqual(result.postId, POST_ID);
		}),
	);

	it.effect("(3) a self-RETRACT is exempt — it reaches Vote.cast (cast-only guard)", () =>
		Effect.gen(function* () {
			const casts: VoteInput[] = [];
			const ops = makePostOperations(deps(recordingVote(casts)));
			yield* ops.retractPostVote({postId: POST_ID, voterId: AUTHOR});
			assert.deepStrictEqual(casts, [
				{userId: AUTHOR, targetKind: "post", targetId: POST_ID, value: false},
			]);
		}),
	);
});
