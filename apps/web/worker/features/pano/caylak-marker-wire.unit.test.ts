/**
 * The reader-facing çaylak marker on pano's two wire shapes (#6425) — `Post` and
 * `Comment`. Driven through the REAL read closures (`makePostOperations` /
 * `makeCommentOperations`) with a substituted `Drizzle` `run` and service doubles, then
 * through the real wire shapers, so what is asserted is the object a client receives.
 *
 * Tier note: the acceptance criteria ask for these viewer shapes at the integration
 * tier. They are asserted here instead for the same reason
 * `comment-count-sandbox-gate.unit.test.ts` states — the integration tier cannot seed a
 * sandboxed row (`sandboxedAt` is resolver-decided from the authorship flag, dark today)
 * and cannot flip `PHOENIX_CAYLAK_VISIBILITY`, which is a remote Flagship flag no
 * deployed test can set. The stamp under test is pure given the resolved `SandboxViewer`,
 * so this tier proves it wrong-or-right (ADR 0082's litmus).
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import type {DrizzleAccessOrDie} from "../../db/Drizzle.ts";
import type {ReactionEmoji} from "../../db/reaction-emoji.ts";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import type {Reaction, ReactionAggregate} from "../reaction/Reaction.ts";
import {definitionViewFields} from "../sozluk/definition-fields.ts";
import type {Vote} from "../vote/Vote.ts";
import type {Bookmark} from "./Bookmark.ts";
import {commentViewFields} from "./comment-fields.ts";
import {type CommentOperationsDeps, makeCommentOperations} from "./comment-operations.ts";
import {postViewFields} from "./post-fields.ts";
import {makePostOperations, type PostOperationsDeps} from "./post-operations.ts";
import {toComment, toPost} from "./shapers.ts";

const CAYLAK = "u-caylak";
const YAZAR = "u-yazar";
const SANDBOXED_AT = new Date("2026-08-01T00:00:00.000Z");

// The viewer shapes acceptance criteria 4 and 5 name. `optedInYazar` is the #6423
// third class with `PHOENIX_CAYLAK_VISIBILITY` on; every other shape is what the
// resolver produces with the flag on but the opt-in absent — which is also, field for
// field, what EVERY shape collapses to with the flag off (#6423 short-circuits on the
// flag before it reads the preference), so the flag-off cases re-use them.
const viewers = {
	anonymous: {viewerId: null, canSeeSandboxed: false, seesSandboxedInPlace: false},
	notOptedInYazar: {viewerId: YAZAR, canSeeSandboxed: false, seesSandboxedInPlace: false},
	otherCaylak: {viewerId: "u-other-caylak", canSeeSandboxed: false, seesSandboxedInPlace: false},
	optedInYazar: {viewerId: YAZAR, canSeeSandboxed: false, seesSandboxedInPlace: true},
} satisfies Record<string, SandboxViewer>;

const maskedShapes = ["anonymous", "notOptedInYazar", "otherCaylak"] as const;

const postRecord = (over: {authorId: string; sandboxedAt: Date | null}) => ({
	id: "post_1",
	slug: "bir-baslik",
	title: "bir başlık",
	url: null,
	host: null,
	body: "gövde",
	bodyExcerpt: "gövde",
	authorId: over.authorId,
	authorName: `snapshot-${over.authorId}`,
	score: 3,
	commentCount: 0,
	hotScore: 0,
	tags: null,
	isDraft: false,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-02T00:00:00.000Z"),
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: over.sandboxedAt,
});

const commentRecord = (over: {authorId: string; sandboxedAt: Date | null}) => ({
	id: "comment_1",
	postId: "post_1",
	postTitle: "bir başlık",
	parentId: null,
	authorId: over.authorId,
	authorName: `snapshot-${over.authorId}`,
	body: "bir yorum",
	bodyExcerpt: null,
	score: 3,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-02T00:00:00.000Z"),
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: over.sandboxedAt,
});

// `run` ignores its query fn (no engine) and replays the script in call order — the
// established shape from `comment-stamp-wave.unit.test.ts`.
const scriptedRun = (results: ReadonlyArray<unknown>): DrizzleAccessOrDie["run"] => {
	let i = 0;
	return (<A>(_fn: unknown) => Effect.succeed(results[i++] as A)) as DrizzleAccessOrDie["run"];
};

// biome-ignore lint/plugin: a service double — only `readMine` is on the read path.
const VoteStub = {
	cast: () => Effect.die(new Error("read path must not cast")),
	readMine: () => Effect.succeed(new Set<string>()),
	clearTarget: () => Effect.void,
} as unknown as typeof Vote.Service;

const ReactionStub = {
	react: () => Effect.die(new Error("read path must not react")),
	readMine: () => Effect.succeed(new Map<string, ReactionEmoji>()),
	clearTarget: () => Effect.void,
	readAggregate: () => Effect.succeed(new Map<string, ReactionAggregate>()),
} satisfies typeof Reaction.Service;

// biome-ignore lint/plugin: a service double — only `readMine` is on the read path.
const BookmarkStub = {
	readMine: () => Effect.succeed(new Set<string>()),
} as unknown as typeof Bookmark.Service;

const readProfileIdentities = () => Effect.succeed([]);

// Every case below reads a row that the viewer IS entitled to (the masking is the
// `sandboxVisibleWhere` predicate's job, proven in `lifecycle/SandboxVisibility.unit.test.ts`),
// so an empty batch here is a broken fixture, not an expected outcome.
const only = <A>(rows: ReadonlyArray<A>): A => {
	const row = rows[0];
	if (row === undefined) throw new Error("the read returned no row");
	return row;
};

const postDeps = (record: ReturnType<typeof postRecord>): PostOperationsDeps => ({
	run: scriptedRun([[record]]),
	batch: (() => Effect.die(new Error("read path must not batch"))) as PostOperationsDeps["batch"],
	voteSvc: VoteStub,
	bookmarkSvc: BookmarkStub,
	reactionSvc: ReactionStub,
	removalSeq: {} as PostOperationsDeps["removalSeq"],
	persistPanoStats: (() => Effect.void) as PostOperationsDeps["persistPanoStats"],
	readProfileIdentities,
});

const commentDeps = (record: ReturnType<typeof commentRecord>): CommentOperationsDeps => ({
	run: scriptedRun([[record]]),
	voteSvc: VoteStub,
	reactionSvc: ReactionStub,
	removalSeq: {} as CommentOperationsDeps["removalSeq"],
	persistPanoStats: (() => Effect.void) as CommentOperationsDeps["persistPanoStats"],
	readProfileIdentities,
});

const readPost = (record: ReturnType<typeof postRecord>, sandboxViewer: SandboxViewer) =>
	Effect.gen(function* () {
		const ops = makePostOperations(postDeps(record));
		const rows = yield* ops.getPostsByIds(["post_1"], {
			viewerId: sandboxViewer.viewerId,
			sandboxViewer,
		});
		return toPost(only(rows));
	});

const readComment = (record: ReturnType<typeof commentRecord>, sandboxViewer: SandboxViewer) =>
	Effect.gen(function* () {
		const ops = makeCommentOperations(commentDeps(record));
		const rows = yield* ops.getCommentsByIds(["comment_1"], {
			viewerId: sandboxViewer.viewerId,
			sandboxViewer,
		});
		return toComment(only(rows));
	});

const caylakSandboxedPost = () => postRecord({authorId: CAYLAK, sandboxedAt: SANDBOXED_AT});
const yazarLivePost = () => postRecord({authorId: YAZAR, sandboxedAt: null});
const caylakSandboxedComment = () => commentRecord({authorId: CAYLAK, sandboxedAt: SANDBOXED_AT});
const yazarLiveComment = () => commentRecord({authorId: YAZAR, sandboxedAt: null});

describe("Post — the çaylak marker on the wire (#6425)", () => {
	it.effect("an opted-in yazar receives it true on a çaylak's sandboxed post", () =>
		Effect.gen(function* () {
			const post = yield* readPost(caylakSandboxedPost(), viewers.optedInYazar);
			assert.isTrue(post.sandboxedInPlace);
			// The owner-scoped field is untouched: this reader is not the author.
			assert.isFalse(post.sandboxed);
		}),
	);

	it.effect("the same yazar receives it false on a yazar-authored live post", () =>
		Effect.gen(function* () {
			const post = yield* readPost(yazarLivePost(), viewers.optedInYazar);
			assert.isFalse(post.sandboxedInPlace);
		}),
	);

	for (const shape of maskedShapes) {
		it.effect(`${shape} never receives it on a çaylak's sandboxed post`, () =>
			Effect.gen(function* () {
				const post = yield* readPost(caylakSandboxedPost(), viewers[shape]);
				assert.isFalse(post.sandboxedInPlace);
			}),
		);
	}

	it.effect("with PHOENIX_CAYLAK_VISIBILITY off it is false for every viewer shape", () =>
		Effect.gen(function* () {
			for (const viewer of Object.values(viewers)) {
				const post = yield* readPost(caylakSandboxedPost(), {
					...viewer,
					seesSandboxedInPlace: false,
				});
				assert.isFalse(post.sandboxedInPlace);
			}
		}),
	);
});

describe("Comment — the çaylak marker on the wire (#6425)", () => {
	it.effect("an opted-in yazar receives it true on a çaylak's sandboxed comment", () =>
		Effect.gen(function* () {
			const comment = yield* readComment(caylakSandboxedComment(), viewers.optedInYazar);
			assert.isTrue(comment.sandboxedInPlace);
			assert.isFalse(comment.sandboxed);
		}),
	);

	it.effect("the same yazar receives it false on a yazar-authored live comment", () =>
		Effect.gen(function* () {
			const comment = yield* readComment(yazarLiveComment(), viewers.optedInYazar);
			assert.isFalse(comment.sandboxedInPlace);
		}),
	);

	for (const shape of maskedShapes) {
		it.effect(`${shape} never receives it on a çaylak's sandboxed comment`, () =>
			Effect.gen(function* () {
				const comment = yield* readComment(caylakSandboxedComment(), viewers[shape]);
				assert.isFalse(comment.sandboxedInPlace);
			}),
		);
	}

	it.effect("with PHOENIX_CAYLAK_VISIBILITY off it is false for every viewer shape", () =>
		Effect.gen(function* () {
			for (const viewer of Object.values(viewers)) {
				const comment = yield* readComment(caylakSandboxedComment(), {
					...viewer,
					seesSandboxedInPlace: false,
				});
				assert.isFalse(comment.sandboxedInPlace);
			}
		}),
	);

	// Selecting the field in each view's field map is what exposes it to a client at all;
	// the `satisfies Record<keyof Row, true>` on each map compile-locks the other direction.
	it("Post, Comment and Definition all select the marker on their view shape", () => {
		assert.strictEqual(postViewFields.sandboxedInPlace, true);
		assert.strictEqual(commentViewFields.sandboxedInPlace, true);
		assert.strictEqual(definitionViewFields.sandboxedInPlace, true);
	});

	// The moderator queue and the delete-placeholder broadcast pass `anonymousViewer`,
	// so a row that may reach a non-author carries neither sandbox signal.
	it.effect("the viewer-blind moderator queue read carries neither sandbox signal", () =>
		Effect.gen(function* () {
			const ops = makeCommentOperations(commentDeps(caylakSandboxedComment()));
			const row = only(yield* ops.listSandboxedComments());
			assert.isFalse(row.sandboxed);
			assert.isFalse(row.sandboxedInPlace);
		}),
	);
});
