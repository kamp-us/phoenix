/**
 * The pano thread/comment stamp-wave collapse (#2710, epic #2567) — behavior equivalence
 * + the concurrency plumbing, over the real `makeCommentOperations` closures with a
 * substituted `Drizzle` `run` + recording service doubles (ADR 0082 litmus: wrong-or-right
 * with no SQL engine → unit). The pano twin of `sozluk/definition-stamp-wave.unit.test.ts`,
 * reusing the same shared `parallelStampWave` combinator behind pano's own seam.
 *
 * Two properties the acceptance criteria name:
 *
 *   - **byte-for-byte equivalence.** `getCommentsByIds` / `listCommentsKeyset` produce the
 *     identical stamped rows whether the wave runs serial (flag off) or concurrent (flag
 *     on) — `myVote`, `reactions`, live author identity all unchanged. The flag flips wall
 *     time and nothing else.
 *   - **the concurrency actually threads through.** With `parallelStamps: true` the reaction
 *     aggregate's own two D1 reads receive `{concurrency: "unbounded"}` (so the wave is one
 *     phase, not one-plus-the-reaction-arm's-two); with it off/absent they receive
 *     `{concurrency: 1}` — today's serial behavior every non-opted caller keeps.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import type {Concurrency} from "effect/Types";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import type {Reaction, ReactionAggregate} from "../reaction/Reaction.ts";
import type {Vote} from "../vote/Vote.ts";
import {type CommentOperationsDeps, makeCommentOperations} from "./comment-operations.ts";

// A `comment_record` shaped just enough for `toCommentRow` + `Removal.fromColumns`.
const commentRecord = (id: string, authorId: string) => ({
	id,
	postId: "post_1",
	postTitle: "A Post",
	parentId: null,
	authorId,
	authorName: `snapshot-${authorId}`,
	body: `body of ${id}`,
	bodyExcerpt: null,
	score: 3,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-02T00:00:00.000Z"),
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: null,
});

const agg = (myReaction: ReactionAggregate["myReaction"]): ReactionAggregate => ({
	counts: [{emoji: "👍", count: 2}],
	myReaction,
});

// Vote double: viewer holds an upvote on `comment_1` only → `myVote === true`, `_2 === false`.
// biome-ignore lint/plugin: a service double — only `readMine` is on the read path.
const VoteStub = {
	cast: () => Effect.die(new Error("read path must not cast")),
	readMine: () => Effect.succeed(new Set<string>(["comment_1"])),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service;

// Reaction double that RECORDS the `options` (the concurrency knob) each `readAggregate`
// call received, and answers a fixed aggregate for `comment_1`.
const reactionRecorder = (
	calls: Array<{readonly concurrency?: Concurrency} | undefined>,
): typeof Reaction.Service =>
	({
		react: () => Effect.die(new Error("read path must not react")),
		readMine: () => Effect.succeed(new Map<string, ReactionEmoji>()),
		clearTarget: () => Effect.void,
		readAggregate: (_viewerId, _kind, _ids, options) => {
			calls.push(options);
			return Effect.succeed(new Map<string, ReactionAggregate>([["comment_1", agg("👍")]]));
		},
	}) satisfies typeof Reaction.Service;

// Pasaport identity double: `comment_1`'s author has a live handle, `_2`'s has none.
const readProfileIdentities = () =>
	Effect.succeed([{userId: "u1", username: "anka", displayName: "Anka Kadın", totalKarma: 0}]);

// Replays `run` results in call order (the sözlük test's `scriptedAccess` shape); each
// answer is a single `as A` — `run` ignores its query fn (no engine), returning the script.
const scriptedRun = (results: ReadonlyArray<unknown>): DrizzleAccessOrDie["run"] => {
	let i = 0;
	return (<A>(_fn: unknown) => Effect.succeed(results[i++] as A)) as DrizzleAccessOrDie["run"];
};

const deps = (
	run: DrizzleAccessOrDie["run"],
	calls: Array<{readonly concurrency?: Concurrency} | undefined>,
): CommentOperationsDeps => ({
	run,
	voteSvc: VoteStub,
	reactionSvc: reactionRecorder(calls),
	removalSeq: {} as CommentOperationsDeps["removalSeq"],
	persistPanoStats: (() => Effect.void) as CommentOperationsDeps["persistPanoStats"],
	readProfileIdentities,
});

// `getCommentsByIds` issues exactly one `run` (the fetch); answer it with two records.
const byIdRun = () =>
	scriptedRun([[commentRecord("comment_1", "u1"), commentRecord("comment_2", "u2")]]);

describe("Pano.getCommentsByIds — stamp-wave behavior equivalence (#2710)", () => {
	it.effect("stamped output is byte-for-byte identical with the wave serial vs concurrent", () => {
		const serialCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
		const parallelCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
		return Effect.gen(function* () {
			const serialOps = makeCommentOperations(deps(byIdRun(), serialCalls));
			const serial = yield* serialOps.getCommentsByIds(["comment_1", "comment_2"], {
				viewerId: "viewer-1",
				parallelStamps: false,
			});

			const parallelOps = makeCommentOperations(deps(byIdRun(), parallelCalls));
			const parallel = yield* parallelOps.getCommentsByIds(["comment_1", "comment_2"], {
				viewerId: "viewer-1",
				parallelStamps: true,
			});

			assert.deepStrictEqual(parallel, serial, "identical stamped rows");
			assert.deepStrictEqual(
				parallel.map((r) => JSON.stringify(r)),
				serial.map((r) => JSON.stringify(r)),
				"identical serialized bytes (fields, values, key order)",
			);
			// Spot the stamps actually landed (not a vacuous equality of two empty pages).
			assert.strictEqual(parallel[0]?.myVote, true, "comment_1 viewer upvote stamped");
			assert.strictEqual(parallel[1]?.myVote, false, "comment_2 no viewer upvote");
			assert.deepStrictEqual(
				parallel[0]?.reactions,
				agg("👍"),
				"comment_1 reaction aggregate stamped",
			);
			assert.strictEqual(parallel[0]?.authorUsername, "anka", "comment_1 live identity stamped");
			assert.strictEqual(parallel[1]?.authorUsername, null, "comment_2 has no live identity");
		});
	});

	it.effect("the flag threads concurrency into the reaction aggregate's own two reads", () => {
		const onCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
		const offCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
		return Effect.gen(function* () {
			yield* makeCommentOperations(deps(byIdRun(), onCalls)).getCommentsByIds(["comment_1"], {
				viewerId: "v",
				parallelStamps: true,
			});
			yield* makeCommentOperations(deps(byIdRun(), offCalls)).getCommentsByIds(["comment_1"], {
				viewerId: "v",
				parallelStamps: false,
			});
			// No `parallelStamps` → the default-off path (today's behavior).
			yield* makeCommentOperations(deps(byIdRun(), offCalls)).getCommentsByIds(["comment_1"], {
				viewerId: "v",
			});

			assert.deepStrictEqual(onCalls, [{concurrency: "unbounded"}], "flag on → unbounded");
			assert.deepStrictEqual(
				offCalls,
				[{concurrency: 1}, {concurrency: 1}],
				"flag off AND absent → sequential (concurrency 1)",
			);
		});
	});
});

// `listCommentsKeyset` (no cursor) issues: totalCount → fetch. Script both in order.
const keysetRun = () =>
	scriptedRun([
		2 /* count */,
		[commentRecord("comment_1", "u1"), commentRecord("comment_2", "u2")] /* fetch */,
	]);

describe("Pano.listCommentsKeyset — stamp-wave behavior equivalence (#2710)", () => {
	it.effect(
		"the connection page is byte-for-byte identical with the wave serial vs concurrent",
		() => {
			const serialCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
			const parallelCalls: Array<{readonly concurrency?: Concurrency} | undefined> = [];
			return Effect.gen(function* () {
				const serialOps = makeCommentOperations(deps(keysetRun(), serialCalls));
				const serial = yield* serialOps.listCommentsKeyset("post_1", {
					first: 10,
					viewerId: "viewer-1",
					parallelStamps: false,
				});

				const parallelOps = makeCommentOperations(deps(keysetRun(), parallelCalls));
				const parallel = yield* parallelOps.listCommentsKeyset("post_1", {
					first: 10,
					viewerId: "viewer-1",
					parallelStamps: true,
				});

				assert.deepStrictEqual(parallel, serial, "identical connection page");
				assert.strictEqual(JSON.stringify(parallel), JSON.stringify(serial), "identical bytes");
				assert.strictEqual(parallel.rows[0]?.myVote, true, "stamps landed on the page");
				assert.deepStrictEqual(parallelCalls, [{concurrency: "unbounded"}], "flag on → unbounded");
				assert.deepStrictEqual(serialCalls, [{concurrency: 1}], "flag off → sequential");
			});
		},
	);
});
