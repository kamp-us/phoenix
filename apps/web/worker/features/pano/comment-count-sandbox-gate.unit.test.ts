/**
 * The public `commentCount` bookkeeping is sandbox-symmetric across create AND
 * delete (#1831). `addComment` gates its `+1` on `sandboxedAt` (a sandboxed çaylak
 * comment (#1205) never bumps the PUBLIC count), but `deleteComment` used to
 * decrement `-1` UNCONDITIONALLY — so deleting a sandboxed comment that was never
 * counted at create drove the public count BELOW the true public total, compounding
 * per deletion (floored at 0 by `Math.max`).
 *
 * The fix mirrors the create-gate on the delete path: the decrement fires only when
 * the deleted comment was NOT sandboxed. This file proves the SERVICE-level count
 * arithmetic directly by driving `addComment`/`deleteComment` (from
 * `makeCommentOperations`) over a recording fake `db` that captures the
 * `post_record.comment_count` each write persists — the sandbox-gated integration
 * suites can't seed a sandboxed comment (the `sandboxedAt` stamp is resolver-decided
 * from the authorship flag, dark today), so the symmetry is asserted at this tier.
 *
 * COUNT-accuracy only: the sandbox boundary itself (containment/visibility) is
 * unchanged and proven elsewhere (#1811, `../flagship/sandbox-restore-escape.invariant.test.ts`).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import * as Lifecycle from "../lifecycle/EntityLifecycle.ts";
import type * as Removal from "../lifecycle/removal.ts";
import type {Reaction} from "../reaction/Reaction.ts";
import type {Vote} from "../vote/Vote.ts";
import {type CommentOperationsDeps, makeCommentOperations} from "./comment-operations.ts";

const POST_ID = "post_1";
const NOW = new Date("2026-07-03T00:00:00.000Z");

type CommentRow = {
	id: string;
	authorId: string;
	authorName: string;
	postId: string;
	postTitle: string;
	parentId: string | null;
	body: string;
	bodyExcerpt: string;
	score: number;
	createdAt: Date;
	updatedAt: Date;
	removedAt: Date | null;
	removedBy: string | null;
	removedReason: string | null;
	sandboxedAt: Date | null;
};

const commentRow = (over: Partial<CommentRow> = {}): CommentRow => ({
	id: "comm_1",
	authorId: "u-author",
	authorName: "yazar",
	postId: POST_ID,
	postTitle: "bir başlık",
	parentId: null,
	body: "bir yorum",
	bodyExcerpt: "bir yorum",
	score: 0,
	createdAt: NOW,
	updatedAt: NOW,
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: null,
	...over,
});

// A recording fake `db`: the four chained shapes `deleteComment` reaches, each
// returning scripted data and capturing the `post_record` count the update
// persists. `commentCount` starts at `startCount`; the captured value is the last
// `.set()` written to `postRecord`.
const fakeDb = (opts: {comment: CommentRow; startCount: number; childCount?: number}) => {
	const captured: {postCommentCount: number | null} = {postCommentCount: null};
	const post = {id: POST_ID, commentCount: opts.startCount, score: 0, createdAt: NOW};
	const db = {
		query: {
			commentRecord: {findFirst: () => Promise.resolve(opts.comment)},
			postRecord: {findFirst: () => Promise.resolve(post)},
		},
		select: () => ({
			from: () => ({where: () => ({get: () => Promise.resolve({n: opts.childCount ?? 0})})}),
		}),
		insert: () => ({values: () => Promise.resolve(undefined)}),
		update: () => ({
			set: (vals: {commentCount?: number}) => ({
				where: () => {
					if (typeof vals.commentCount === "number") captured.postCommentCount = vals.commentCount;
					return Promise.resolve(undefined);
				},
			}),
		}),
	};
	return {db, captured};
};

// `deleteComment` reaches only `removalSeq.clearTarget` + `removalSeq.run` (the
// comment removal stamp) — both inert here; the count write happens at the call
// site over the fake `db.update(postRecord)`, which we capture instead.
const inertRemovalSeq: Removal.RemovalSequence = {
	run: () => Effect.succeed(undefined as never),
	batch: () => Effect.succeed(undefined as never),
	clearTarget: () => Effect.void,
};

const deps = (run: DrizzleAccessOrDie["run"]): CommentOperationsDeps => ({
	run,
	voteSvc: {} as typeof Vote.Service,
	reactionSvc: {} as typeof Reaction.Service,
	removalSeq: inertRemovalSeq,
	persistPanoStats: () => Effect.void,
	// The delete path never re-resolves live author identity (it stamps a count, not a
	// read row), so a fail-on-contact reader proves that: reaching it fails the test.
	readProfileIdentities: () =>
		Effect.die(new Error("comment delete-count path must not read author identity")),
});

const runOverDb = (db: unknown): DrizzleAccessOrDie["run"] =>
	(<A>(fn: (d: never) => Promise<A> | A) =>
		Effect.promise(async () => fn(db as never))) as DrizzleAccessOrDie["run"];

describe("commentCount is sandbox-symmetric across create/delete (#1831)", () => {
	it.effect("deleting a SANDBOXED comment leaves the public count unchanged (-0, not -1)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({
				comment: commentRow({sandboxedAt: NOW}),
				startCount: 5,
			});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			const result = yield* ops.deleteComment({commentId: "comm_1", actorId: "u-author"});
			assert.isTrue(result.deleted, "the delete still soft-removes the comment");
			assert.strictEqual(
				captured.postCommentCount,
				5,
				"a sandboxed comment was never counted at create, so its delete must not decrement the public count",
			);
		}),
	);

	it.effect("deleting a NON-sandboxed comment decrements the public count by one (-1)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({
				comment: commentRow({sandboxedAt: null}),
				startCount: 5,
			});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			const result = yield* ops.deleteComment({commentId: "comm_1", actorId: "u-author"});
			assert.isTrue(result.deleted, "the delete soft-removes the comment");
			assert.strictEqual(
				captured.postCommentCount,
				4,
				"a normal comment was counted at create, so its delete decrements the public count",
			);
		}),
	);

	it.effect("the decrement is floored at 0 — a sandboxed delete never drifts below truth", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({
				comment: commentRow({sandboxedAt: NOW}),
				startCount: 0,
			});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			yield* ops.deleteComment({commentId: "comm_1", actorId: "u-author"});
			assert.strictEqual(
				captured.postCommentCount,
				0,
				"a sandboxed delete against a zero public count stays at 0, never negative",
			);
		}),
	);

	// The create side of the symmetry: addComment is already sandbox-gated (#1205);
	// pinning it here keeps the create/delete mirror visible in one file.
	it.effect("adding a SANDBOXED comment does not bump the public count (+0)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({comment: commentRow(), startCount: 5});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			yield* ops.addComment({
				postId: POST_ID,
				authorId: "u-author",
				authorName: "yazar",
				body: "sandboxed",
				sandboxedAt: NOW,
			});
			assert.strictEqual(captured.postCommentCount, 5, "a sandboxed comment does not bump +1");
		}),
	);

	it.effect("adding a NON-sandboxed comment bumps the public count by one (+1)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({comment: commentRow(), startCount: 5});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			yield* ops.addComment({
				postId: POST_ID,
				authorId: "u-author",
				authorName: "yazar",
				body: "live",
				sandboxedAt: null,
			});
			assert.strictEqual(captured.postCommentCount, 6, "a live comment bumps +1");
		}),
	);
});

// A removed row as it sits after a mod-remove: the ADR 0096 triad stamped, plus the
// preserved pre-removal `sandboxedAt` marker (null if it was live). `Removal.fromColumns`
// projects this to `Removed`, and `Removal.restore` round-trips the marker back.
const removedRow = (sandboxedAt: Date | null): CommentRow =>
	commentRow({
		removedAt: NOW,
		removedBy: "u-mod",
		removedReason: Lifecycle.encodeReason(new Lifecycle.Moderated({reportId: "rep_1"})),
		sandboxedAt,
	});

// The MODERATOR remove/restore pair is sandbox-gated on the same arithmetic as the author
// paths (#1835): a mod path that touches a SANDBOXED comment — a public count that never
// counted it — must not drift the public `comment_count`. The pair is internally symmetric
// (`-1`/`+1`), so the drift only appears against a sandboxed comment or across a now-gated
// author path (mod-remove sandboxed `-0` then author-restore `+0`).
describe("commentCount is sandbox-gated across the MODERATOR remove/restore pair (#1835)", () => {
	it.effect("mod-removing a SANDBOXED comment leaves the public count unchanged (-0, not -1)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({comment: commentRow({sandboxedAt: NOW}), startCount: 5});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			const result = yield* ops.moderateRemoveComment({
				commentId: "comm_1",
				resolverId: "u-mod",
				reportId: "rep_1",
			});
			assert.isTrue(result.removed, "the mod-remove still soft-removes the comment");
			assert.strictEqual(
				captured.postCommentCount,
				5,
				"a sandboxed comment was never counted at create, so a mod-remove must not decrement",
			);
		}),
	);

	it.effect("mod-removing a NON-sandboxed comment decrements the public count by one (-1)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({comment: commentRow({sandboxedAt: null}), startCount: 5});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			const result = yield* ops.moderateRemoveComment({
				commentId: "comm_1",
				resolverId: "u-mod",
				reportId: "rep_1",
			});
			assert.isTrue(result.removed, "the mod-remove soft-removes the comment");
			assert.strictEqual(captured.postCommentCount, 4, "a live comment's mod-remove decrements -1");
		}),
	);

	it.effect("mod-restoring a SANDBOXED comment does not bump the public count (+0, not +1)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({comment: removedRow(NOW), startCount: 5});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			const result = yield* ops.moderateRestoreComment({commentId: "comm_1"});
			assert.isTrue(result.restored, "the mod-restore un-removes the comment");
			assert.strictEqual(
				captured.postCommentCount,
				5,
				"a comment restored to Sandboxed is not in the public thread, so it must not bump +1",
			);
		}),
	);

	it.effect("mod-restoring a NON-sandboxed comment bumps the public count by one (+1)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({comment: removedRow(null), startCount: 5});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			const result = yield* ops.moderateRestoreComment({commentId: "comm_1"});
			assert.isTrue(result.restored, "the mod-restore un-removes the comment");
			assert.strictEqual(captured.postCommentCount, 6, "a comment restored to Live bumps +1");
		}),
	);

	it.effect("a sandboxed mod-remove → mod-restore round-trip nets zero (never drifts)", () =>
		Effect.gen(function* () {
			// mod-remove of the sandboxed live comment: -0
			const remove = fakeDb({comment: commentRow({sandboxedAt: NOW}), startCount: 5});
			const opsRemove = makeCommentOperations(deps(runOverDb(remove.db)));
			yield* opsRemove.moderateRemoveComment({
				commentId: "comm_1",
				resolverId: "u-mod",
				reportId: "rep_1",
			});
			assert.strictEqual(remove.captured.postCommentCount, 5, "mod-remove of sandboxed is -0");

			// mod-restore of the now removed-AND-sandboxed row: +0 — the public count is back where it started
			const restore = fakeDb({comment: removedRow(NOW), startCount: 5});
			const opsRestore = makeCommentOperations(deps(runOverDb(restore.db)));
			yield* opsRestore.moderateRestoreComment({commentId: "comm_1"});
			assert.strictEqual(
				restore.captured.postCommentCount,
				5,
				"mod-restore of sandboxed is +0 — the round-trip never drifts the public count",
			);
		}),
	);

	it.effect(
		"cross-path: mod-remove SANDBOXED (-0) then author restoreComment (+0) never drifts",
		() =>
			Effect.gen(function* () {
				// mod-remove of a sandboxed comment: -0 (the ungated bug would have made this -1)
				const remove = fakeDb({comment: commentRow({sandboxedAt: NOW}), startCount: 5});
				const opsRemove = makeCommentOperations(deps(runOverDb(remove.db)));
				yield* opsRemove.moderateRemoveComment({
					commentId: "comm_1",
					resolverId: "u-mod",
					reportId: "rep_1",
				});
				assert.strictEqual(remove.captured.postCommentCount, 5, "mod-remove of sandboxed is -0");

				// author restoreComment of the removed-AND-sandboxed row: +0 (author-gated, #1811)
				const restore = fakeDb({comment: removedRow(NOW), startCount: 5});
				const opsRestore = makeCommentOperations(deps(runOverDb(restore.db)));
				yield* opsRestore.restoreComment({commentId: "comm_1", actorId: "u-author"});
				assert.strictEqual(
					restore.captured.postCommentCount,
					5,
					"author-restore of sandboxed is +0 — the cross-path nets zero, no net -1 drift",
				);
			}),
	);
});
