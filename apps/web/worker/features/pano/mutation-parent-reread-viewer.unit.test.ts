/**
 * The parent-page re-read in `post.restore`, `comment.delete` and `comment.restore` carries
 * the acting author's identity (#6473).
 *
 * Each handler commits its write, re-reads the parent post through `Pano.getPost` — a read
 * masked on the sandbox dimension — and answers `null` when the row comes back masked. Handed
 * no viewer at all, that read resolved anonymously, so a çaylak restoring their OWN still-
 * sandboxed post got `null` back from a mutation that had already landed at D1.
 *
 * The stub does not mimic the mask: it resolves the options through the real
 * `resolveSandboxViewer` and asks the real `lifecycleVisibilityRule`, so the test moves with
 * the visibility rule instead of restating it.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {
	lifecycleVisibilityRule,
	ruleVisibleTo,
	type SandboxViewer,
} from "../lifecycle/EntityLifecycle.ts";
import {resolveSandboxViewer} from "../lifecycle/SandboxVisibility.ts";
import {mutations} from "./mutations.ts";
import {Pano} from "./Pano.ts";
import type {PostPage} from "./post-fields.ts";

const AUTHOR = {id: "u-caylak", email: "caylak@kamp.us", name: "çaylak"};
const OTHER_MEMBER = {id: "u-yazar", email: "yazar@kamp.us", name: "yazar"};
const POST_ID = "post_sb1";
const COMMENT_ID = "comment_sb1";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "mutation-parent-reread-viewer",
	id: "mutation-parent-reread-viewer",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

/** The çaylak's own still-sandboxed post — the parent page every handler re-reads. */
const sandboxedPage: PostPage = {
	id: POST_ID,
	slug: "post-sb1",
	title: "başlık",
	url: null,
	host: null,
	body: "gövde",
	author: "çaylak",
	authorId: AUTHOR.id,
	score: 1,
	commentCount: 1,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	tags: [],
};

const noopLive = Layer.succeed(LivePublisher)(
	livePublisherFor({publish: () => Effect.void, waitUntil: () => {}}),
);

const commentRow = {
	id: COMMENT_ID,
	postId: POST_ID,
	parentId: null,
	body: "yorum",
	author: "çaylak",
	authorId: AUTHOR.id,
	score: 0,
	createdAt: sandboxedPage.createdAt,
	updatedAt: sandboxedPage.updatedAt,
	deletedAt: null,
	myVote: null,
};

/**
 * Every service the three handlers reach. `getPost` applies the REAL sandbox rule to the
 * viewer the call site resolved, so a call that omits the viewer masks exactly as D1 does.
 */
const contextFor = (user: typeof AUTHOR) =>
	Layer.mergeAll(
		// biome-ignore lint/plugin: a service double — the writes are scripted and only the parent re-read is under test.
		Layer.succeed(Pano, {
			restorePost: () => Effect.succeed({postId: POST_ID, deleted: false, sandboxedAt: new Date()}),
			lookupCommentPostId: () => Effect.succeed(POST_ID),
			deleteComment: () =>
				Effect.succeed({
					commentId: COMMENT_ID,
					deleted: true,
					hasReplies: false,
					placeholder: null,
				}),
			restoreComment: () =>
				Effect.succeed({
					commentId: COMMENT_ID,
					deleted: false,
					hasReplies: false,
					placeholder: null,
					sandboxedAt: new Date(),
				}),
			getPost: (_id: string, opts?: {viewerId?: string | null; sandboxViewer?: SandboxViewer}) =>
				Effect.sync(() =>
					ruleVisibleTo(
						lifecycleVisibilityRule.Sandboxed,
						sandboxedPage.authorId,
						resolveSandboxViewer(opts ?? {}),
					)
						? sandboxedPage
						: null,
				),
			getPostsByIds: () => Effect.succeed([]),
			getCommentsByIds: () => Effect.succeed([commentRow]),
		} as unknown as typeof Pano.Service),
		noopLive,
		Layer.succeed(CurrentUser, {user}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
	);

// Named at each call site rather than looked up from a union: the three carry different
// error unions, and a union-typed lookup erases what `resolveWire` infers from.
const HANDLERS = [
	{
		name: "post.restore",
		run: (ctx: ReturnType<typeof contextFor>) =>
			resolveWire(mutations["post.restore"], {input: {id: POST_ID}, select: ["id"]}).pipe(
				Effect.provide(ctx),
			),
	},
	{
		name: "comment.delete",
		run: (ctx: ReturnType<typeof contextFor>) =>
			resolveWire(mutations["comment.delete"], {input: {id: COMMENT_ID}, select: ["id"]}).pipe(
				Effect.provide(ctx),
			),
	},
	{
		name: "comment.restore",
		run: (ctx: ReturnType<typeof contextFor>) =>
			resolveWire(mutations["comment.restore"], {input: {id: COMMENT_ID}, select: ["id"]}).pipe(
				Effect.provide(ctx),
			),
	},
] as const;

describe("the pano parent-page re-reads carry the acting author (#6473)", () => {
	for (const handler of HANDLERS) {
		it.effect(`${handler.name} returns the still-sandboxed page to its own author`, () =>
			Effect.gen(function* () {
				const result = yield* handler.run(contextFor(AUTHOR));
				assert.isNotNull(result, `${handler.name} answered null on a write that landed`);
				assert.strictEqual(result?.id, POST_ID);
			}),
		);

		it.effect(`${handler.name} still masks the sandboxed page from another member`, () =>
			Effect.gen(function* () {
				assert.isNull(yield* handler.run(contextFor(OTHER_MEMBER)));
			}),
		);
	}
});
