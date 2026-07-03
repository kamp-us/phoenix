/**
 * The çaylak sandbox-escape-via-restore security invariant (#1811). A çaylak
 * escapes the #1205 mod-only sandbox for their OWN content by deleting then
 * restoring it: the old `restore : Removed → Live` was unconditional and both
 * `toColumns(Removed)`/`toColumns(Live)` nulled `sandboxedAt`, so a delete→restore
 * round-trip cleared the sandbox marker AND broadcast the node to the always-Live
 * public feed — no moderator in the loop. This defeats the sandbox for all three
 * content types through the ONE shared `EntityLifecycle.restore` seam.
 *
 * The fix (state-preserving, ADR 0096 extended): `Removed` carries the pre-removal
 * `sandboxedAt`, so `restore` is sandbox-FAITHFUL — sandboxed content returns to
 * `Sandboxed`, only live content returns to `Live`. The pure lifecycle proof lives
 * in `../lifecycle/EntityLifecycle.unit.test.ts` (`restore : Removed → Sandboxed`,
 * the column round-trip). This file proves the RESOLVER consequence directly: the
 * restore broadcast is routed through the #1205/#1280 `decidePublish` gate, so a
 * sandboxed restore is SUPPRESSED from the viewer-blind public topic — for post,
 * comment, AND definition, the three call sites of the one fix.
 *
 * Wire-boundary unit test (ADR 0082): the `Pano`/`Sozluk`/`LivePublisher` seams are
 * substituted directly — no DB. The service's restore returns the `sandboxedAt` the
 * content landed back at; a recording `LivePublisher` captures which topic keys the
 * resolver actually published, so "a sandboxed restore does not reach the public
 * feed" is asserted as the ABSENCE of the node-append topic. Mirrors the
 * handler-over-stubs seam of `../pano/draft-save.invariant.test.ts` and
 * `../sozluk/definition-mutation.unit.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {liveConnectionTopic, liveGlobalConnectionTopic} from "@nkzw/fate/server";
import {Effect, Layer} from "effect";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import type {CommentRow} from "../pano/comment-fields.ts";
import {mutations as panoMutations} from "../pano/mutations.ts";
import {Pano, type PostPage} from "../pano/Pano.ts";
import type {PostSummaryRow} from "../pano/post-fields.ts";
import type {DefinitionRow} from "../sozluk/definition-fields.ts";
import {mutations as sozlukMutations} from "../sozluk/mutations.ts";
import {Sozluk, type TermPage} from "../sozluk/Sozluk.ts";

const AUTHOR = {id: "caylak-1", email: "caylak@example.com", name: "çaylak"};
const AT = new Date("2026-07-03T00:00:00.000Z");

// A recording `LivePublisher`: `publish` captures the topic key the resolver's
// `live.*` chose; `waitUntil` collects the fire-and-forget work so it can be
// drained. The gated `appendNode` publishes NOTHING when `decidePublish` suppresses
// it (`broadcastIf` returns `Effect.void`), so a suppressed restore leaves the topic
// absent from `recorded` — exactly the escape-prevention assertion.
const recordingLive = () => {
	const recorded: Array<string> = [];
	const scheduled: Array<Promise<unknown>> = [];
	const layer = Layer.succeed(LivePublisher)(
		livePublisherFor({
			publish: (topicKey) =>
				Effect.sync(() => {
					recorded.push(topicKey);
				}),
			waitUntil: (promise) => {
				scheduled.push(promise);
			},
		}),
	);
	return {recorded, scheduled, layer};
};

const drain = (scheduled: Array<Promise<unknown>>) =>
	Effect.promise(() => Promise.allSettled(scheduled));

// Service stubs (the `definition-mutation.unit.test.ts` proxy idiom): only the
// methods the restore resolver reaches are scripted; every other method dies on
// contact, so a passing test proves the resolver touched only the restore
// round-trip + the re-resolve reads. `sandboxedAt` is what the service's restore
// reports (non-null ⇒ landed back in the sandbox).
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

// The gated node-append topic each restore path routes through — the viewer-blind
// public topic a sandbox escape would leak the node onto.
const POST_FEED_TOPIC = liveGlobalConnectionTopic("posts");
const COMMENT_THREAD_TOPIC = liveConnectionTopic("Post.comments", {id: "post-1"});
const DEFINITION_TERM_TOPIC = liveConnectionTopic("Term.definitions", {id: "term-1"});

describe("çaylak sandbox-escape via delete→restore is structurally prevented (#1811)", () => {
	// POST — the restore broadcast is gated; sandboxed ⇒ suppressed, live ⇒ published.
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
				.handler({input: {id: "post-1"}, select: ["id"]})
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

	// COMMENT — `live.post.update` (commentCount) always fires; the GATED signal is the
	// thread appendNode, so filter to it.
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
				.handler({input: {id: "comment-1"}, select: ["id"]})
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

	// DEFINITION
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
				.handler({input: {id: "def-1"}, select: ["id"]})
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
