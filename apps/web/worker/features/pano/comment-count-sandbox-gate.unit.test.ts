/**
 * The public `commentCount` must be sandbox-symmetric across create AND delete
 * (#1831): a sandboxed comment never bumps `+1` at create, so its delete must not
 * decrement `-1`, or the public count drifts below truth, compounding per deletion.
 *
 * Asserted at the unit tier over a recording fake `db` because the integration suites
 * cannot seed a sandboxed comment — the `sandboxedAt` stamp is resolver-decided from
 * the authorship flag, dark today. Count accuracy only; the sandbox boundary itself is
 * proven in `../flagship/sandbox-restore-escape.invariant.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import {UserId} from "../../lib/ids.ts";
import * as Lifecycle from "../lifecycle/EntityLifecycle.ts";
import type * as Removal from "../lifecycle/removal.ts";
import type {Reaction} from "../reaction/Reaction.ts";
import {ReportId} from "../report/ids.ts";
import type {Vote} from "../vote/Vote.ts";
import {type CommentOperationsDeps, makeCommentOperations} from "./comment-operations.ts";
import {CommentId, PostId} from "./ids.ts";

const POST_ID = PostId.make("post_1");
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

// The captured value is the last `.set()` written to `postRecord`.
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
	// Fail-on-contact: the delete path stamps a count, never re-resolves author identity,
	// so reaching this reader must fail the test.
	readProfileIdentities: () =>
		Effect.die(new Error("comment delete-count path must not read author identity")),
});

/** A rejection from the stubbed `run` thunk — dies, matching `run`'s `never` channel. */
class RunRejected extends Schema.TaggedErrorClass<RunRejected>()("test/RunRejected", {
	cause: Schema.Unknown,
}) {}

const runOverDb = (db: unknown): DrizzleAccessOrDie["run"] =>
	(<A>(fn: (d: never) => Promise<A> | A) =>
		Effect.tryPromise({
			try: async () => fn(db as never),
			catch: (cause) => new RunRejected({cause}),
		}).pipe(Effect.orDie)) as DrizzleAccessOrDie["run"];

describe("commentCount is sandbox-symmetric across create/delete (#1831)", () => {
	it.effect("deleting a SANDBOXED comment leaves the public count unchanged (-0, not -1)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({
				comment: commentRow({sandboxedAt: NOW}),
				startCount: 5,
			});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			const result = yield* ops.deleteComment({
				commentId: CommentId.make("comm_1"),
				actorId: UserId.make("u-author"),
			});
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
			const result = yield* ops.deleteComment({
				commentId: CommentId.make("comm_1"),
				actorId: UserId.make("u-author"),
			});
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
			yield* ops.deleteComment({
				commentId: CommentId.make("comm_1"),
				actorId: UserId.make("u-author"),
			});
			assert.strictEqual(
				captured.postCommentCount,
				0,
				"a sandboxed delete against a zero public count stays at 0, never negative",
			);
		}),
	);

	it.effect("adding a SANDBOXED comment does not bump the public count (+0)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({comment: commentRow(), startCount: 5});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			yield* ops.addComment({
				postId: POST_ID,
				authorId: UserId.make("u-author"),
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
				authorId: UserId.make("u-author"),
				authorName: "yazar",
				body: "live",
				sandboxedAt: null,
			});
			assert.strictEqual(captured.postCommentCount, 6, "a live comment bumps +1");
		}),
	);
});

// A removed row as it sits after a mod-remove: the ADR 0096 triad stamped, plus the
// preserved pre-removal `sandboxedAt` marker (null if it was live).
const removedRow = (sandboxedAt: Date | null): CommentRow =>
	commentRow({
		removedAt: NOW,
		removedBy: "u-mod",
		removedReason: Lifecycle.encodeReason(
			new Lifecycle.Moderated({reportId: ReportId.make("rep_1")}),
		),
		sandboxedAt,
	});

// The mod pair is internally symmetric (`-1`/`+1`), so drift only shows against a
// sandboxed comment or across a now-gated author path — hence the cross-path case.
describe("commentCount is sandbox-gated across the MODERATOR remove/restore pair (#1835)", () => {
	it.effect("mod-removing a SANDBOXED comment leaves the public count unchanged (-0, not -1)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({comment: commentRow({sandboxedAt: NOW}), startCount: 5});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			const result = yield* ops.moderateRemoveComment({
				commentId: "comm_1",
				resolverId: "u-mod",
				reportId: ReportId.make("rep_1"),
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
				reportId: ReportId.make("rep_1"),
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
			const remove = fakeDb({comment: commentRow({sandboxedAt: NOW}), startCount: 5});
			const opsRemove = makeCommentOperations(deps(runOverDb(remove.db)));
			yield* opsRemove.moderateRemoveComment({
				commentId: "comm_1",
				resolverId: "u-mod",
				reportId: ReportId.make("rep_1"),
			});
			assert.strictEqual(remove.captured.postCommentCount, 5, "mod-remove of sandboxed is -0");

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
				const remove = fakeDb({comment: commentRow({sandboxedAt: NOW}), startCount: 5});
				const opsRemove = makeCommentOperations(deps(runOverDb(remove.db)));
				yield* opsRemove.moderateRemoveComment({
					commentId: "comm_1",
					resolverId: "u-mod",
					reportId: ReportId.make("rep_1"),
				});
				assert.strictEqual(remove.captured.postCommentCount, 5, "mod-remove of sandboxed is -0");

				const restore = fakeDb({comment: removedRow(NOW), startCount: 5});
				const opsRestore = makeCommentOperations(deps(runOverDb(restore.db)));
				yield* opsRestore.restoreComment({
					commentId: CommentId.make("comm_1"),
					actorId: UserId.make("u-author"),
				});
				assert.strictEqual(
					restore.captured.postCommentCount,
					5,
					"author-restore of sandboxed is +0 — the cross-path nets zero, no net -1 drift",
				);
			}),
	);
});

// The last arithmetic branch not asserted directly; its +0 sandboxed arm is covered by
// the cross-path test above.
describe("commentCount is sandbox-gated on the author restoreComment path (#1811)", () => {
	it.effect("author-restoring a NON-sandboxed comment bumps the public count by one (+1)", () =>
		Effect.gen(function* () {
			const {db, captured} = fakeDb({comment: removedRow(null), startCount: 5});
			const ops = makeCommentOperations(deps(runOverDb(db)));
			const result = yield* ops.restoreComment({
				commentId: CommentId.make("comm_1"),
				actorId: UserId.make("u-author"),
			});
			assert.isTrue(result.deleted, "the author-restore un-removes the comment");
			assert.strictEqual(
				captured.postCommentCount,
				6,
				"a comment restored to Live was not counted while removed, so its restore bumps +1",
			);
		}),
	);
});
