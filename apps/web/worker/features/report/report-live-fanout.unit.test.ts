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
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Layer} from "effect";
import {makeNotificationStub} from "../bildirim/Notification.testing.ts";
import {noRequestFlagOverrides} from "../fate/resolve-wire.testing.ts";
import {livePublisherFor} from "../fate-live/live-publisher.ts";
import {Flags} from "../flagship/Flags.ts";
import {Kunye} from "../kunye/Kunye.ts";
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
		subjectsOf: ({relation}) => Effect.succeed(new Set(relation === "moderates" ? holders : [])),
	});

const agentAuthorityStub = Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(false)});

// The mod-emitter deps `report.submit` gained (#1699): `Flags` OFF ⇒ `bildirimOn` is
// false ⇒ the report-filed page no-ops before the moderator read / notification write.
const runtimeContextStub: BaseRuntimeContext = {
	Type: "report-live-fanout-test",
	id: "report-live-fanout-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};
const bildirimOffStub = Layer.mergeAll(
	Layer.succeed(Flags, {
		getBoolean: () => Effect.succeed(false),
		getString: () => Effect.die("getString not exercised"),
		getNumber: () => Effect.die("getNumber not exercised"),
		getObject: () => Effect.die("getObject not exercised"),
	} as typeof Flags.Service),
	Layer.succeed(RuntimeContext, runtimeContextStub),
	noRequestFlagOverrides,
	makeNotificationStub(),
	relationStoreOf([]),
	// The karma flag-gate deps `report.submit` gained (#150): `Flags` OFF ⇒ the
	// `CanFlag` gate auto-passes without a karma read, so `Kunye.karmaOf` dies on
	// contact (unexercised); the proof still stamps off the per-test `CurrentActor`.
	Layer.succeed(Kunye, {
		karmaOf: () => Effect.die("Kunye.karmaOf not exercised in report-live-fanout (flag off)"),
		tierOf: () => Effect.die("Kunye.tierOf not exercised in report-live-fanout"),
		rootOf: (id: string) => Effect.succeed(id),
	} as typeof Kunye.Service),
);

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

// #1855: the wave grouping the client generates rides the SAME `report.resolve` input,
// threaded to `resolveTarget` so the batch's rows carry one shared id. A capturing stub
// records what the handler passed down (a dismiss avoids the remove/publish detour).
describe("report.resolve — threads the wave grouping id to resolveTarget (#1855)", () => {
	const capturingReport = (sink: {waveId?: string | null}) =>
		makeReportStub({
			resolveTarget: (input) =>
				Effect.sync(() => {
					sink.waveId = input.waveId ?? null;
					return {collapsed: 1};
				}),
		});

	// Pano/Sozluk are in the handler's static R (the remove branch), never reached on a
	// dismiss — empty stubs die on contact, proving the dismiss path never touches them.
	const gate = <ROut>(extra: Layer.Layer<ROut, never, never>) =>
		Layer.mergeAll(
			extra,
			Layer.succeed(Pano, panoStub({})),
			Layer.succeed(Sozluk, sozlukStub({})),
			relationStoreOf([MOD]),
			agentAuthorityStub,
			actorContext(human(MOD)),
		);

	it.effect("a wave-fanned resolve carrying a waveId passes it through", () => {
		const sink: {waveId?: string | null} = {};
		const {layer} = recordingPublisher();
		return Effect.gen(function* () {
			yield* mutations["report.resolve"].handler({
				input: {targetKind: "post", targetId: "p1", action: "dismiss", waveId: "wave-1"},
				select: ["id"],
			});
			assert.strictEqual(sink.waveId, "wave-1", "the shared wave id reaches resolveTarget");
		}).pipe(Effect.provide(gate(Layer.mergeAll(capturingReport(sink), layer))));
	});

	it.effect("a single-target resolve (no waveId) passes null — no grouping", () => {
		const sink: {waveId?: string | null} = {};
		const {layer} = recordingPublisher();
		return Effect.gen(function* () {
			yield* mutations["report.resolve"].handler({
				input: {targetKind: "post", targetId: "p1", action: "dismiss"},
				select: ["id"],
			});
			assert.strictEqual(sink.waveId, null, "a lone resolve carries no wave grouping");
		}).pipe(Effect.provide(gate(Layer.mergeAll(capturingReport(sink), layer))));
	});
});

// #1704 AC3: restoring a wave-removal (one ledger event, #1855) restores EVERY target in
// the batch as a unit. The handler reads the wave's targets, brings each back live (the same
// per-target restore + live re-append the lone restore runs), then reopens the whole batch.
describe("report.restoreWave — restores the batch as a unit (#1704 AC3)", () => {
	// A `Report` scripted for a two-target wave: `waveTargets` names the batch, `reopenForWave`
	// reopens it. Every other method fail-on-contact — the path touches only these.
	const waveReportStub = (
		targets: ReadonlyArray<{targetKind: "post" | "comment" | "definition"; targetId: string}>,
	) =>
		makeReportStub({
			waveTargets: () => Effect.succeed(targets),
			reopenForWave: () => Effect.succeed({reopened: targets.length}),
		});

	it.effect("brings every target back live AND reopens the batch (post + definition)", () => {
		const {recorded, scheduled, layer} = recordingPublisher();
		return Effect.gen(function* () {
			const receipt = yield* mutations["report.restoreWave"].handler({
				input: {waveId: "wave-1"},
				select: ["id", "collapsed"],
			});
			yield* flush(scheduled);
			// Each target re-enters its subscribed connection — the batch restored as a unit.
			assert.deepStrictEqual(recorded, [
				liveGlobalConnectionTopic("posts"),
				liveConnectionTopic("Term.definitions", {id: "effect"}),
			]);
			// The ack reports how many reports reopened across the wave.
			assert.strictEqual((receipt as {collapsed: number}).collapsed, 2);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					waveReportStub([
						{targetKind: "post", targetId: "p1"},
						{targetKind: "definition", targetId: "d1"},
					]),
					Layer.succeed(
						Pano,
						panoStub({
							moderateRestorePost: () => Effect.succeed({restored: true, sandboxedAt: null}),
							getPostsByIds: () => Effect.succeed([postRow("p1")]),
						}),
					),
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

	it.effect("an empty wave (already reopened) fans out nothing and reopens zero", () => {
		const {recorded, scheduled, layer} = recordingPublisher();
		return Effect.gen(function* () {
			const receipt = yield* mutations["report.restoreWave"].handler({
				input: {waveId: "wave-gone"},
				select: ["id", "collapsed"],
			});
			yield* flush(scheduled);
			assert.deepStrictEqual(recorded, []);
			assert.strictEqual((receipt as {collapsed: number}).collapsed, 0);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeReportStub({
						waveTargets: () => Effect.succeed([]),
						reopenForWave: () => Effect.succeed({reopened: 0}),
					}),
					Layer.succeed(Pano, panoStub({})),
					Layer.succeed(Sozluk, sozlukStub({})),
					layer,
					relationStoreOf([MOD]),
					agentAuthorityStub,
					actorContext(human(MOD)),
				),
			),
		);
	});

	it.effect("a NON-moderator is denied — the wave body never runs (invisible denial)", () => {
		const {layer} = recordingPublisher();
		return Effect.gen(function* () {
			const exit = yield* Effect.exit(
				mutations["report.restoreWave"].handler({input: {waveId: "wave-1"}, select: ["id"]}),
			);
			assert.isTrue(exit._tag === "Failure", "a non-moderator restoreWave is denied");
			if (exit._tag === "Failure") {
				// The künye invisible denial — never leaks the wave exists.
				assert.match(String(Cause.pretty(exit.cause)), /Denied|UNAUTHORIZED/);
			}
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					// fail-on-contact Report/Pano/Sozluk: the gate denies BEFORE the body, so a
					// reached `waveTargets`/restore would die and fail the test.
					makeReportStub({}),
					Layer.succeed(Pano, panoStub({})),
					Layer.succeed(Sozluk, sozlukStub({})),
					layer,
					relationStoreOf([]),
					agentAuthorityStub,
					actorContext(human("u-not-mod")),
				),
			),
		);
	});
});

describe("report.submit — the audit refuted submit; the CONTENT path fans out nothing", () => {
	it.effect(
		"submit never publishes to a CONTENT topic (a private report row changes no subscribed content)",
		() =>
			// The submit handler never touches `WorkerLivePublisher` on the content path — a
			// report is private moderation state. Its ONLY live dependency is the bildirim
			// spine's per-recipient `Notification.record` delivery (#2076/#1699), gated OFF
			// here (`bildirimOffStub`), so the recording publisher captures NOTHING.
			Effect.gen(function* () {
				const {recorded, scheduled, layer} = recordingPublisher();
				const receipt = yield* mutations["report.submit"]
					.handler({
						input: {targetKind: "post", targetId: "p1"},
						select: ["id", "created"],
					})
					.pipe(
						Effect.provideService(CurrentUser, {user: {id: "u-reporter"} as never}),
						Effect.provide(
							Layer.mergeAll(
								makeReportStub({
									submit: () => Effect.succeed({targetKind: "post", targetId: "p1", created: true}),
								}),
								layer,
								actorContext(human("u-reporter")),
								bildirimOffStub,
							),
						),
					);
				yield* flush(scheduled);
				assert.strictEqual((receipt as {created: boolean}).created, true);
				assert.deepStrictEqual(recorded, [], "submit published to no topic (content or bildirim)");
			}),
	);
});
