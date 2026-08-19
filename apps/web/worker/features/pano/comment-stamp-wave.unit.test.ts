/**
 * The pano stamp-wave collapse (#2710). Two properties: the flag flips wall time and
 * NOTHING else (byte-for-byte identical rows serial vs concurrent), and the concurrency
 * actually reaches the reaction aggregate's own two reads rather than stopping one level
 * up. Pano twin of `sozluk/definition-stamp-wave.unit.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import type {Concurrency} from "effect/Types";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import type {Reaction, ReactionAggregate} from "../reaction/Reaction.ts";
import type {Vote} from "../vote/Vote.ts";
import {type CommentOperationsDeps, makeCommentOperations} from "./comment-operations.ts";

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

// Records the `options` (the concurrency knob) each `readAggregate` call received.
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

// `comment_1`'s author has a live handle, `_2`'s deliberately has none.
const readProfileIdentities = () =>
	Effect.succeed([{userId: "u1", username: "anka", displayName: "Anka Kadın", totalKarma: 0}]);

// Replays results in call order; `run` ignores its query fn since there is no SQL engine.
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

// `getCommentsByIds` issues exactly one `run` (the fetch).
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
			// Guards against a vacuous equality of two empty pages.
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
			// No `parallelStamps` at all → the default-off path.
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

// `listCommentsKeyset` (no cursor) issues totalCount then fetch, in that order.
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
