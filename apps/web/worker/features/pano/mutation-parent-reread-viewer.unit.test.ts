/**
 * The parent-page re-read in `post.restore`, `comment.delete` and `comment.restore` carries
 * the viewer the request resolved — the acting author (#6473) and the opted-in in-place
 * yazar (#6586).
 *
 * Each handler commits its write, re-reads the parent post through `Pano.getPost` — a read
 * masked on the sandbox dimension — and answers `null` when the row comes back masked. Handed
 * a degraded viewer, that read resolves neither elevated class, so a çaylak restoring their
 * OWN still-sandboxed post, and an opted-in yazar acting on somebody else's, both got `null`
 * back from a mutation that had already landed at D1.
 *
 * The stub does not mimic the mask: it asks the real `lifecycleVisibilityRule` about the
 * viewer it was handed, so the test moves with the visibility rule instead of restating it,
 * and that viewer arrives through the real resolver rather than a hand-built one.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {sandboxViewerLayer} from "../kunye/sandbox.testing.ts";
import {
	lifecycleVisibilityRule,
	ruleVisibleTo,
	type SandboxViewer,
} from "../lifecycle/EntityLifecycle.ts";
import {mutations} from "./mutations.ts";
import {Pano} from "./Pano.ts";
import type {PostPage} from "./post-fields.ts";

const AUTHOR = {id: "u-caylak", email: "caylak@kamp.us", name: "çaylak"};
const OTHER_MEMBER = {id: "u-yazar", email: "yazar@kamp.us", name: "yazar"};
const POST_ID = "post_sb1";
const COMMENT_ID = "comment_sb1";
const OPTED_IN_AT = new Date("2026-08-19T00:00:00.000Z");

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

type Axes = Parameters<typeof sandboxViewerLayer>[0];

/** A signed-in member with the çaylak-visibility flag off: no in-place widening exists yet. */
const plainMember = (user: typeof AUTHOR): Axes => ({
	flagOn: false,
	viewerId: user.id,
	isModerator: false,
});

/** The #6423 third class: a yazar who opted in to reading çaylak work in place. */
const optedInYazar = (user: typeof AUTHOR): Axes => ({
	flagOn: true,
	tier: "yazar",
	preference: {optedIn: true, setAt: OPTED_IN_AT},
	viewerId: user.id,
	isModerator: false,
});

/**
 * Every service the three handlers reach. `getPost` applies the REAL sandbox rule to the
 * viewer it was handed, so a handler that hands it a degraded one masks exactly as D1 does.
 */
const contextFor = (user: typeof AUTHOR, axes: Axes) =>
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
			getPost: (_id: string, opts: {sandboxViewer: SandboxViewer}) =>
				Effect.sync(() =>
					ruleVisibleTo(
						lifecycleVisibilityRule.Sandboxed,
						sandboxedPage.authorId,
						opts.sandboxViewer,
					)
						? sandboxedPage
						: null,
				),
			getPostsByIds: () => Effect.succeed([]),
			getCommentsByIds: () => Effect.succeed([commentRow]),
		} as unknown as typeof Pano.Service),
		noopLive,
		sandboxViewerLayer(axes),
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

describe("the pano parent-page re-reads carry the resolved viewer (#6473, #6586)", () => {
	for (const handler of HANDLERS) {
		it.effect(`${handler.name} returns the still-sandboxed page to its own author`, () =>
			Effect.gen(function* () {
				const result = yield* handler.run(contextFor(AUTHOR, plainMember(AUTHOR)));
				assert.isNotNull(result, `${handler.name} answered null on a write that landed`);
				assert.strictEqual(result?.id, POST_ID);
			}),
		);

		it.effect(`${handler.name} still masks the sandboxed page from another member`, () =>
			Effect.gen(function* () {
				assert.isNull(yield* handler.run(contextFor(OTHER_MEMBER, plainMember(OTHER_MEMBER))));
			}),
		);

		it.effect(`${handler.name} returns the page to an opted-in in-place yazar`, () =>
			Effect.gen(function* () {
				const result = yield* handler.run(contextFor(OTHER_MEMBER, optedInYazar(OTHER_MEMBER)));
				assert.isNotNull(result, `${handler.name} answered null on a write that landed`);
				assert.strictEqual(result?.id, POST_ID);
			}),
		);
	}
});
