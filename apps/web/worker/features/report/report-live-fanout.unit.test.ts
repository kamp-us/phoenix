/**
 * `report.resolve` / `report.restore` LIVE-FANOUT unit coverage (#1895, audit #1892).
 *
 * A moderator remove/restore hides or un-hides a `Post` / `Comment` / `Definition` —
 * the exact three entities that live in the subscribed `posts` / `Post.comments` /
 * `Term.definitions` connections. Before #1895 the moderator path fanned out NOTHING,
 * so a second connected moderator (and every other client) kept rendering the removed
 * content live until a manual reload. This drives the REAL resolve/restore handlers over
 * stub `Report` / `Pano` / `Sozluk` services and a recording `LivePublisher`, asserting
 * the resolver publishes the SAME invalidation the user-delete paths do — the
 * handler-over-stubs + recording-publisher seam `sozluk/definition-mutation.unit.test.ts`
 * uses. The publisher's key-MATH is pinned in `../fate-live/live-publisher.unit.test.ts`;
 * this asserts the resolver's routing CHOICE.
 *
 * The moderation gate is discharged the same way `divan/divan-vote-mutation.unit.test.ts`
 * does: a `RelationStore` holding the actor's `moderates` tuple + `CurrentActor` mints the
 * `Moderate` grant, so the gated body runs.
 */

import {assert, describe, it} from "@effect/vitest";
import {type Actor, AgentAuthority, CurrentActor, human, RelationStore} from "@kampus/authz";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {liveConnectionTopic, liveEntityTopic, liveGlobalConnectionTopic} from "@nkzw/fate/server";
import {Effect, Layer} from "effect";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {Pano} from "../pano/Pano.ts";
import {Sozluk} from "../sozluk/Sozluk.ts";
import {mutations} from "./mutations.ts";
import {makeReportStub} from "./Report.testing.ts";

const MOD = "u-mod";

const relationStoreOf = (holders: ReadonlyArray<string>): Layer.Layer<RelationStore> =>
	Layer.succeed(RelationStore, {
		has: (tuple) =>
			Effect.succeed(tuple.relation === "moderates" && holders.includes(tuple.subject)),
		hasSubjects: ({subjects, relation}) =>
			Effect.succeed(
				new Set(relation === "moderates" ? subjects.filter((s) => holders.includes(s)) : []),
			),
	});

const agentAuthorityStub = Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(false)});

const actorContext = (actor: Actor) => Layer.succeed(CurrentActor, {actor});

// A `Report` scripted so a `remove`/restore resolves its target and collapses/reopens
// one report — every unlisted method fail-on-contact, so the test proves the path
// touched only these.
const reportStub = (target: {targetKind: "post" | "comment" | "definition"; targetId: string}) =>
	makeReportStub({
		lookupReportTarget: () => Effect.succeed(target),
		firstOpenReportId: () => Effect.succeed("r1"),
		resolveTarget: () => Effect.succeed({collapsed: 1}),
		reopenForTarget: () => Effect.succeed({reopened: 1}),
	});

// Proxy stubs over `Pano`/`Sozluk`: scripted methods answer, every other dies on
// contact — mirrors `definition-mutation.unit.test.ts`'s `sozlukStub`.
const panoStub = (impl: Partial<typeof Pano.Service>): typeof Pano.Service =>
	proxyOver("Pano", impl);
const sozlukStub = (impl: Partial<typeof Sozluk.Service>): typeof Sozluk.Service =>
	proxyOver("Sozluk", impl);

const proxyOver = <T extends object>(service: string, impl: Partial<T>): T =>
	new Proxy(impl, {
		get(t, prop) {
			if (prop in t) return (t as Record<string, unknown>)[prop as string];
			return () => Effect.die(`${service}.${String(prop)} not exercised`);
		},
	}) as T;

const definitionRow = (id: string) => ({
	id,
	body: "a definition",
	score: 0,
	author: "yazar",
	authorId: "u-author",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	myVote: null,
});

const postRow = (id: string) => ({
	id,
	slug: "a-post",
	title: "A post",
	url: null,
	host: null,
	body: "body",
	author: "yazar",
	authorId: "u-author",
	score: 0,
	commentCount: 0,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	myVote: null,
	isSaved: null,
	tags: [] as never[],
});

const commentRow = (id: string) => ({
	id,
	parentId: null,
	author: "yazar",
	authorId: "u-author",
	body: "a comment",
	score: 0,
	createdAt: new Date("2026-01-01T00:00:00Z"),
	updatedAt: new Date("2026-01-01T00:00:00Z"),
	deletedAt: null,
	myVote: null,
});

// A recording `LivePublisher`: `publish` captures the topic key the resolver's `live.*`
// chose; `waitUntil` collects the detached publish work so `flush` drains it.
const recordingPublisher = () => {
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

const flush = (scheduled: Array<Promise<unknown>>) =>
	Effect.promise(() => Promise.allSettled(scheduled));

describe("report.resolve remove — publishes the content-topic invalidation", () => {
	it.effect("a moderator remove of a post evicts the entity + drops its feed edge", () => {
		const {recorded, scheduled, layer} = recordingPublisher();
		return Effect.gen(function* () {
			yield* mutations["report.resolve"].handler({
				input: {targetKind: "post", targetId: "p1", action: "remove"},
				select: ["id"],
			});
			yield* flush(scheduled);
			assert.deepStrictEqual(recorded, [
				liveEntityTopic("Post", "p1"),
				liveGlobalConnectionTopic("posts"),
			]);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					reportStub({targetKind: "post", targetId: "p1"}),
					Layer.succeed(
						Pano,
						panoStub({moderateRemovePost: () => Effect.succeed({removed: true})}),
					),
					Layer.succeed(Sozluk, sozlukStub({})),
					layer,
					relationStoreOf([MOD]),
					agentAuthorityStub,
					actorContext(human(MOD)),
				),
			),
		);
	});

	it.effect("a moderator remove of a comment drops the thread edge on the parent post", () => {
		const {recorded, scheduled, layer} = recordingPublisher();
		return Effect.gen(function* () {
			yield* mutations["report.resolve"].handler({
				input: {targetKind: "comment", targetId: "c1", action: "remove"},
				select: ["id"],
			});
			yield* flush(scheduled);
			assert.deepStrictEqual(recorded, [liveConnectionTopic("Post.comments", {id: "post-1"})]);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					reportStub({targetKind: "comment", targetId: "c1"}),
					Layer.succeed(
						Pano,
						panoStub({
							moderateRemoveComment: () => Effect.succeed({removed: true}),
							lookupCommentPostId: () => Effect.succeed("post-1"),
						}),
					),
					Layer.succeed(Sozluk, sozlukStub({})),
					layer,
					relationStoreOf([MOD]),
					agentAuthorityStub,
					actorContext(human(MOD)),
				),
			),
		);
	});

	it.effect("a moderator remove of a definition evicts + drops its term edge", () => {
		const {recorded, scheduled, layer} = recordingPublisher();
		return Effect.gen(function* () {
			yield* mutations["report.resolve"].handler({
				input: {targetKind: "definition", targetId: "d1", action: "remove"},
				select: ["id"],
			});
			yield* flush(scheduled);
			assert.deepStrictEqual(recorded, [
				liveEntityTopic("Definition", "d1"),
				liveConnectionTopic("Term.definitions", {id: "effect"}),
			]);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					reportStub({targetKind: "definition", targetId: "d1"}),
					Layer.succeed(Pano, panoStub({})),
					Layer.succeed(
						Sozluk,
						sozlukStub({
							moderateRemoveDefinition: () => Effect.succeed({removed: true}),
							lookupDefinitionTermSlug: () => Effect.succeed("effect"),
						}),
					),
					layer,
					relationStoreOf([MOD]),
					agentAuthorityStub,
					actorContext(human(MOD)),
				),
			),
		);
	});

	it.effect("a no-op remove (already removed) fans out nothing", () => {
		const {recorded, scheduled, layer} = recordingPublisher();
		return Effect.gen(function* () {
			yield* mutations["report.resolve"].handler({
				input: {targetKind: "post", targetId: "p1", action: "remove"},
				select: ["id"],
			});
			yield* flush(scheduled);
			assert.deepStrictEqual(recorded, []);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					reportStub({targetKind: "post", targetId: "p1"}),
					Layer.succeed(
						Pano,
						panoStub({moderateRemovePost: () => Effect.succeed({removed: false})}),
					),
					Layer.succeed(Sozluk, sozlukStub({})),
					layer,
					relationStoreOf([MOD]),
					agentAuthorityStub,
					actorContext(human(MOD)),
				),
			),
		);
	});
});

describe("report.restore — re-enters the target so a second moderator reconciles live", () => {
	it.effect(
		"a live post restore re-appends it to the feed (the second-moderator reconcile)",
		() => {
			const {recorded, scheduled, layer} = recordingPublisher();
			return Effect.gen(function* () {
				yield* mutations["report.restore"].handler({
					input: {targetKind: "post", targetId: "p1"},
					select: ["id"],
				});
				yield* flush(scheduled);
				assert.deepStrictEqual(recorded, [liveGlobalConnectionTopic("posts")]);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						reportStub({targetKind: "post", targetId: "p1"}),
						Layer.succeed(
							Pano,
							panoStub({
								moderateRestorePost: () => Effect.succeed({restored: true, sandboxedAt: null}),
								getPostsByIds: () => Effect.succeed([postRow("p1")]),
							}),
						),
						Layer.succeed(Sozluk, sozlukStub({})),
						layer,
						relationStoreOf([MOD]),
						agentAuthorityStub,
						actorContext(human(MOD)),
					),
				),
			);
		},
	);

	it.effect(
		"a SANDBOXED post restore is suppressed from the public feed (ADR 0082 / #1205)",
		() => {
			const {recorded, scheduled, layer} = recordingPublisher();
			return Effect.gen(function* () {
				yield* mutations["report.restore"].handler({
					input: {targetKind: "post", targetId: "p1"},
					select: ["id"],
				});
				yield* flush(scheduled);
				// The round-tripped sandbox marker gates the re-append via decidePublish — a
				// sandboxed restore broadcasts NOTHING to the viewer-blind public feed.
				assert.deepStrictEqual(recorded, []);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						reportStub({targetKind: "post", targetId: "p1"}),
						Layer.succeed(
							Pano,
							panoStub({
								moderateRestorePost: () =>
									Effect.succeed({restored: true, sandboxedAt: new Date("2026-01-01T00:00:00Z")}),
								getPostsByIds: () => Effect.succeed([postRow("p1")]),
							}),
						),
						Layer.succeed(Sozluk, sozlukStub({})),
						layer,
						relationStoreOf([MOD]),
						agentAuthorityStub,
						actorContext(human(MOD)),
					),
				),
			);
		},
	);

	it.effect("a comment restore re-appends it to the parent post's thread", () => {
		const {recorded, scheduled, layer} = recordingPublisher();
		return Effect.gen(function* () {
			yield* mutations["report.restore"].handler({
				input: {targetKind: "comment", targetId: "c1"},
				select: ["id"],
			});
			yield* flush(scheduled);
			assert.deepStrictEqual(recorded, [liveConnectionTopic("Post.comments", {id: "post-1"})]);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					reportStub({targetKind: "comment", targetId: "c1"}),
					Layer.succeed(
						Pano,
						panoStub({
							moderateRestoreComment: () => Effect.succeed({restored: true, sandboxedAt: null}),
							lookupCommentPostId: () => Effect.succeed("post-1"),
							getCommentsByIds: () => Effect.succeed([commentRow("c1")]),
						}),
					),
					Layer.succeed(Sozluk, sozlukStub({})),
					layer,
					relationStoreOf([MOD]),
					agentAuthorityStub,
					actorContext(human(MOD)),
				),
			),
		);
	});

	it.effect("a definition restore re-appends it to the term connection", () => {
		const {recorded, scheduled, layer} = recordingPublisher();
		return Effect.gen(function* () {
			yield* mutations["report.restore"].handler({
				input: {targetKind: "definition", targetId: "d1"},
				select: ["id"],
			});
			yield* flush(scheduled);
			assert.deepStrictEqual(recorded, [liveConnectionTopic("Term.definitions", {id: "effect"})]);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					reportStub({targetKind: "definition", targetId: "d1"}),
					Layer.succeed(Pano, panoStub({})),
					Layer.succeed(
						Sozluk,
						sozlukStub({
							moderateRestoreDefinition: () => Effect.succeed({restored: true, sandboxedAt: null}),
							lookupDefinitionTermSlug: () => Effect.succeed("effect"),
							getDefinitionsByIds: () => Effect.succeed([definitionRow("d1")]),
						}),
					),
					layer,
					relationStoreOf([MOD]),
					agentAuthorityStub,
					actorContext(human(MOD)),
				),
			),
		);
	});
});

describe("fail-safe — a failed publish does not fail the moderation action", () => {
	it.effect("a DYING publisher still lands the removal (the fail-safe contract)", () => {
		const failing = Layer.succeed(LivePublisher)(
			livePublisherFor({
				publish: () => Effect.die(new Error("publish blew up")),
				waitUntil: () => {},
			}),
		);
		return Effect.gen(function* () {
			// The receipt still resolves even though every publish dies — the publisher's
			// `never` error channel swallows the failure off the request path.
			const receipt = yield* mutations["report.resolve"].handler({
				input: {targetKind: "post", targetId: "p1", action: "remove"},
				select: ["id", "targetRemoved"],
			});
			assert.strictEqual((receipt as {targetRemoved: boolean}).targetRemoved, true);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					reportStub({targetKind: "post", targetId: "p1"}),
					Layer.succeed(
						Pano,
						panoStub({moderateRemovePost: () => Effect.succeed({removed: true})}),
					),
					Layer.succeed(Sozluk, sozlukStub({})),
					failing,
					relationStoreOf([MOD]),
					agentAuthorityStub,
					actorContext(human(MOD)),
				),
			),
		);
	});
});

describe("report.submit — the audit refuted submit; it fans out nothing", () => {
	it.effect(
		"submit acquires NO publisher (a private report row changes no subscribed content)",
		() =>
			// The submit handler never reaches `WorkerLivePublisher` — a fail-on-contact
			// publisher would DIE if it did. That it lands with no `LivePublisher` provided
			// at all is the strongest proof: submit's R-channel carries no live dependency.
			Effect.gen(function* () {
				const receipt = yield* mutations["report.submit"]
					.handler({
						input: {targetKind: "post", targetId: "p1"},
						select: ["id", "created"],
					})
					.pipe(Effect.provideService(CurrentUser, {user: {id: "u-reporter"} as never}));
				assert.strictEqual((receipt as {created: boolean}).created, true);
			}).pipe(
				Effect.provide(
					makeReportStub({
						submit: () => Effect.succeed({targetKind: "post", targetId: "p1", created: true}),
					}),
				),
			),
	);
});
