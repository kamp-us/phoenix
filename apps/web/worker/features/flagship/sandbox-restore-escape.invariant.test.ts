/**
 * The çaylak sandbox-escape-via-restore security invariant (#1811): a çaylak used to
 * escape the #1205 mod-only sandbox by deleting then restoring their own content, since
 * `restore` cleared `sandboxedAt` and broadcast the node to the always-Live public feed
 * with no moderator in the loop.
 *
 * The pure lifecycle proof (`restore : Removed → Sandboxed`) lives in
 * `../lifecycle/EntityLifecycle.unit.test.ts`. This file proves the RESOLVER consequence
 * for post, comment AND definition: a sandboxed restore is asserted as the ABSENCE of the
 * node-append topic on a recording `LivePublisher` (wire-boundary, no DB — ADR 0082).
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {liveConnectionTopic, liveGlobalConnectionTopic} from "@nkzw/fate/server";
import {Effect, Layer} from "effect";
import * as Schema from "effect/Schema";
import {DefinitionId} from "../../lib/ids.ts";
import {noopPanoFeedCache} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import type {CommentRow} from "../pano/comment-fields.ts";
import {CommentId, PostId} from "../pano/ids.ts";
import {mutations as panoMutations} from "../pano/mutations.ts";
import {Pano, type PostPage} from "../pano/Pano.ts";
import type {PostSummaryRow} from "../pano/post-fields.ts";
import type {DefinitionRow} from "../sozluk/definition-fields.ts";
import {mutations as sozlukMutations} from "../sozluk/mutations.ts";
import {Sozluk, type TermPage} from "../sozluk/Sozluk.ts";

const AUTHOR = {id: "caylak-1", email: "caylak@example.com", name: "çaylak"};
const AT = new Date("2026-07-03T00:00:00.000Z");

// The gated `appendNode` publishes NOTHING when `decidePublish` suppresses it, so a
// suppressed restore leaves the topic absent from `recorded` — the assertion itself.
const recordingLive = () => {
	const recorded: Array<string> = [];
	const scheduled: Array<Promise<unknown>> = [];
	const layer = Layer.mergeAll(
		Layer.succeed(LivePublisher)(
			livePublisherFor({
				publish: (topicKey) =>
					Effect.sync(() => {
						recorded.push(topicKey);
					}),
				waitUntil: (promise) => {
					scheduled.push(promise);
				},
			}),
		),
		noopPanoFeedCache,
	);
	return {recorded, scheduled, layer};
};

class DrainRejected extends Schema.TaggedErrorClass<DrainRejected>()("test/DrainRejected", {
	cause: Schema.Unknown,
}) {}

const drain = (scheduled: Array<Promise<unknown>>) =>
	Effect.tryPromise({
		try: () => Promise.allSettled(scheduled),
		catch: (cause) => new DrainRejected({cause}),
	}).pipe(Effect.orDie);

// Every unscripted method dies on contact, so a passing test proves the resolver touched
// only the restore round-trip + the re-resolve reads.
const panoStub = (methods: Partial<typeof Pano.Service>): Layer.Layer<Pano> =>
	Layer.succeed(
		Pano,
		new Proxy(methods, {
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () => Effect.die(`Pano.${String(prop)} not exercised in sandbox-restore-escape`);
			},
		}) as typeof Pano.Service,
	);

const sozlukStub = (methods: Partial<typeof Sozluk.Service>): Layer.Layer<Sozluk> =>
	Layer.succeed(
		Sozluk,
		new Proxy(methods, {
			get(target, prop) {
				if (prop in target) return (target as Record<string, unknown>)[prop as string];
				return () => Effect.die(`Sozluk.${String(prop)} not exercised in sandbox-restore-escape`);
			},
		}) as typeof Sozluk.Service,
	);

const postPage = (): PostPage => ({
	id: "post-1",
	slug: "post-1",
	title: "a çaylak post",
	url: null,
	host: null,
	body: null,
	author: AUTHOR.name,
	authorId: AUTHOR.id,
	score: 0,
	commentCount: 0,
	createdAt: AT,
	updatedAt: AT,
	tags: [],
});

const postSummaryRow = (): PostSummaryRow => ({...postPage(), myVote: null, isSaved: null});

const commentRow = (): CommentRow => ({
	id: "comment-1",
	parentId: null,
	author: AUTHOR.name,
	authorId: AUTHOR.id,
	body: "a çaylak comment",
	score: 0,
	createdAt: AT,
	updatedAt: AT,
	deletedAt: null,
	myVote: null,
});

const definitionRow = (): DefinitionRow => ({
	id: "def-1",
	body: "a çaylak definition",
	score: 0,
	author: AUTHOR.name,
	authorId: AUTHOR.id,
	createdAt: AT,
	updatedAt: AT,
});

const termPage = (): TermPage => ({
	id: "term-1",
	slug: "term-1",
	title: "bir terim",
	totalDefinitions: 1,
	totalScore: 0,
	firstAt: AT,
	lastEdit: AT,
	definitions: [definitionRow()],
});

// The viewer-blind public topics a sandbox escape would leak the node onto.
const POST_FEED_TOPIC = liveGlobalConnectionTopic("posts");
const COMMENT_THREAD_TOPIC = liveConnectionTopic("Post.comments", {id: "post-1"});
const DEFINITION_TERM_TOPIC = liveConnectionTopic("Term.definitions", {id: "term-1"});

describe("çaylak sandbox-escape via delete→restore is structurally prevented (#1811)", () => {
	const runPostRestore = (restoreSandboxedAt: Date | null) =>
		Effect.gen(function* () {
			const {recorded, scheduled, layer} = recordingLive();
			const pano = panoStub({
				restorePost: () =>
					Effect.succeed({postId: "post-1", deleted: true, sandboxedAt: restoreSandboxedAt}),
				getPost: () => Effect.succeed(postPage()),
				getPostsByIds: () => Effect.succeed([postSummaryRow()]),
			});
			yield* panoMutations["post.restore"]
				.handler({input: {id: PostId.make("post-1")}, select: ["id"]})
				.pipe(
					Effect.provide(Layer.mergeAll(pano, layer)),
					Effect.provideService(CurrentUser, {user: AUTHOR}),
				);
			yield* drain(scheduled);
			return recorded;
		});

	it.effect("a sandboxed post restore does NOT broadcast to the public feed", () =>
		Effect.gen(function* () {
			const recorded = yield* runPostRestore(AT);
			assert.isFalse(
				recorded.includes(POST_FEED_TOPIC),
				"sandboxed post restore must be suppressed from the always-Live feed — self-escape prevented",
			);
		}),
	);

	it.effect("a live post restore still broadcasts to the public feed (no regression)", () =>
		Effect.gen(function* () {
			const recorded = yield* runPostRestore(null);
			assert.isTrue(
				recorded.includes(POST_FEED_TOPIC),
				"a live-before-removal post restore must still re-enter the public feed",
			);
		}),
	);

	// `live.post.update` (commentCount) always fires; the GATED signal is the thread
	// appendNode, so the assertions filter to it.
	const runCommentRestore = (restoreSandboxedAt: Date | null) =>
		Effect.gen(function* () {
			const {recorded, scheduled, layer} = recordingLive();
			const pano = panoStub({
				lookupCommentPostId: () => Effect.succeed("post-1"),
				restoreComment: () =>
					Effect.succeed({
						commentId: "comment-1",
						deleted: true,
						hasReplies: false,
						placeholder: null,
						sandboxedAt: restoreSandboxedAt,
					}),
				getCommentsByIds: () => Effect.succeed([commentRow()]),
				getPost: () => Effect.succeed(postPage()),
				getPostsByIds: () => Effect.succeed([postSummaryRow()]),
			});
			yield* panoMutations["comment.restore"]
				.handler({input: {id: CommentId.make("comment-1")}, select: ["id"]})
				.pipe(
					Effect.provide(Layer.mergeAll(pano, layer)),
					Effect.provideService(CurrentUser, {user: AUTHOR}),
				);
			yield* drain(scheduled);
			return recorded;
		});

	it.effect("a sandboxed comment restore does NOT broadcast to the thread topic", () =>
		Effect.gen(function* () {
			const recorded = yield* runCommentRestore(AT);
			assert.isFalse(
				recorded.includes(COMMENT_THREAD_TOPIC),
				"sandboxed comment restore must be suppressed from the viewer-blind thread topic",
			);
		}),
	);

	it.effect("a live comment restore still broadcasts to the thread topic (no regression)", () =>
		Effect.gen(function* () {
			const recorded = yield* runCommentRestore(null);
			assert.isTrue(
				recorded.includes(COMMENT_THREAD_TOPIC),
				"a live-before-removal comment restore must still re-append to its thread",
			);
		}),
	);

	const runDefinitionRestore = (restoreSandboxedAt: Date | null) =>
		Effect.gen(function* () {
			const {recorded, scheduled, layer} = recordingLive();
			const sozluk = sozlukStub({
				restoreDefinition: () =>
					Effect.succeed({definitionId: "def-1", deleted: true, sandboxedAt: restoreSandboxedAt}),
				lookupDefinitionTermSlug: () => Effect.succeed("term-1"),
				getTerm: () => Effect.succeed(termPage()),
			});
			yield* sozlukMutations["definition.restore"]
				.handler({input: {id: DefinitionId.make("def-1")}, select: ["id"]})
				.pipe(
					Effect.provide(Layer.mergeAll(sozluk, layer)),
					Effect.provideService(CurrentUser, {user: AUTHOR}),
				);
			yield* drain(scheduled);
			return recorded;
		});

	it.effect("a sandboxed definition restore does NOT broadcast to the term topic", () =>
		Effect.gen(function* () {
			const recorded = yield* runDefinitionRestore(AT);
			assert.isFalse(
				recorded.includes(DEFINITION_TERM_TOPIC),
				"sandboxed definition restore must be suppressed from the viewer-blind term topic",
			);
		}),
	);

	it.effect("a live definition restore still broadcasts to the term topic (no regression)", () =>
		Effect.gen(function* () {
			const recorded = yield* runDefinitionRestore(null);
			assert.isTrue(
				recorded.includes(DEFINITION_TERM_TOPIC),
				"a live-before-removal definition restore must still re-enter its term",
			);
		}),
	);
});
