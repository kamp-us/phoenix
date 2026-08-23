/**
 * Rite-feedback emitter coverage — the decisions that are wrong-or-right with no
 * database (ADR 0082 T1/T2). The `Notification` seam is a fail-on-contact stub with
 * only the expected method overridden, so "touched the wrong write surface" fails.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {noRequestFlagOverrides} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {Mute} from "../mute/Mute.ts";
import {makeNotificationStub} from "./Notification.testing.ts";
import type {NotificationAggregateInput, NotificationRecordInput} from "./Notification.ts";
import {
	BACKLOG_RELEASE_KIND,
	DIVAN_VOTE_KIND,
	KEFIL_KIND,
	notifyBacklogRelease,
	notifyDivanVote,
	notifyKefil,
	notifyPromotion,
	PROMOTION_KIND,
	riteRecipient,
} from "./rite-emitters.ts";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "rite-emitters-test",
	id: "rite-emitters-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

const flagsStub = (on: boolean): Layer.Layer<Flags> =>
	Layer.succeed(
		Flags,
		// biome-ignore lint/plugin: a Flags test double — only getBoolean is exercised here.
		{
			getBoolean: () => Effect.succeed(on),
			getString: () => Effect.die(new Error("unused")),
			getNumber: () => Effect.die(new Error("unused")),
			getObject: () => Effect.die(new Error("unused")),
		} as unknown as typeof Flags.Service,
	);

// The stub `record` never publishes, so a do-nothing publisher just satisfies the
// requirement; the live publish itself is covered in `Notification.unit.test.ts`.
const noopLivePublisher = Layer.succeed(LivePublisher)({
	update: () => Effect.void,
	delete: () => Effect.void,
	invalidate: () => Effect.void,
	topic: () => {
		throw new Error("noopLivePublisher.topic unused");
	},
} as typeof LivePublisher.Service);

// An empty mute set puts every case here on the deliver path; muted-suppression is
// covered in mute-suppression.unit.test.ts.
const noMutes = Layer.succeed(Mute, {
	set: () => Effect.die("Mute.set not exercised"),
	listMine: () => Effect.die("Mute.listMine not exercised"),
	readMutedIds: () => Effect.succeed(new Set<string>()),
});

const requestContext = (on: boolean) =>
	Layer.mergeAll(
		flagsStub(on),
		Layer.succeed(CurrentUser, {user: undefined}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
		noRequestFlagOverrides,
		noopLivePublisher,
		noMutes,
	);

describe("riteRecipient — self-suppression, pure", () => {
	it("resolves the recipient when actor and recipient differ", () => {
		assert.strictEqual(riteRecipient("u-author", "u-voter"), "u-author");
	});
	it("suppresses when the actor IS the recipient", () => {
		assert.strictEqual(riteRecipient("u-author", "u-author"), null);
	});
});

describe("notifyDivanVote — the aggregated divan-vote emit", () => {
	it.effect("routes through recordAggregate with the author recipient and NO actor identity", () =>
		Effect.gen(function* () {
			const calls: NotificationAggregateInput[] = [];
			yield* notifyDivanVote({
				authorId: "u-author",
				actorId: "u-voter",
				targetKind: "post",
				targetId: "p1",
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeNotificationStub({
							recordAggregate: (input) => {
								calls.push(input);
								return Effect.succeed({aggregated: false});
							},
						}),
						requestContext(true),
					),
				),
			);
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0], {
				recipientId: "u-author",
				kind: DIVAN_VOTE_KIND,
				targetKind: "post",
				targetId: "p1",
				actorId: null,
			});
		}),
	);

	it.effect("a self-vote emits nothing (the fail-on-contact stub is never touched)", () =>
		notifyDivanVote({
			authorId: "u-author",
			actorId: "u-author",
			targetKind: "post",
			targetId: "p1",
		}).pipe(Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(true)))),
	);

	it.effect("with the bildirim flag OFF the write never happens (dark by default)", () =>
		notifyDivanVote({
			authorId: "u-author",
			actorId: "u-voter",
			targetKind: "post",
			targetId: "p1",
		}).pipe(Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(false)))),
	);

	it.effect(
		"a DYING notification write is swallowed — the caller still succeeds (the seam AC)",
		() =>
			Effect.gen(function* () {
				// The default stub DIES on contact — the exact defect shape `orDieAccess`
				// raises on a D1 failure.
				const exit = yield* notifyDivanVote({
					authorId: "u-author",
					actorId: "u-voter",
					targetKind: "post",
					targetId: "p1",
				}).pipe(
					Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(true))),
					Effect.exit,
				);
				assert.strictEqual(exit._tag, "Success");
			}),
	);
});

describe("notifyKefil — the vouch-received emit", () => {
	it.effect("records one kefil notification for the vouched çaylak", () =>
		Effect.gen(function* () {
			const calls: NotificationRecordInput[] = [];
			yield* notifyKefil({candidateId: "u-caylak", voucherId: "u-yazar"}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeNotificationStub({
							record: (input) => {
								calls.push(input);
								return Effect.succeed({id: "n1"});
							},
						}),
						requestContext(true),
					),
				),
			);
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0], {
				recipientId: "u-caylak",
				kind: KEFIL_KIND,
				targetKind: "user",
				targetId: "u-caylak",
				actorId: "u-yazar",
			});
		}),
	);

	it.effect("a self-vouch emits nothing", () =>
		notifyKefil({candidateId: "u-same", voucherId: "u-same"}).pipe(
			Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(true))),
		),
	);

	it.effect("a DYING notification write is swallowed — the vouch caller still succeeds", () =>
		Effect.gen(function* () {
			const exit = yield* notifyKefil({candidateId: "u-caylak", voucherId: "u-yazar"}).pipe(
				Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(true))),
				Effect.exit,
			);
			assert.strictEqual(exit._tag, "Success");
		}),
	);
});

describe("notifyPromotion — the çaylak→yazar ceremony emit", () => {
	it.effect("records one promotion notification for the promoted member (no actor identity)", () =>
		Effect.gen(function* () {
			const calls: NotificationRecordInput[] = [];
			yield* notifyPromotion({userId: "u-promoted"}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeNotificationStub({
							record: (input) => {
								calls.push(input);
								return Effect.succeed({id: "n1"});
							},
						}),
						requestContext(true),
					),
				),
			);
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0], {
				recipientId: "u-promoted",
				kind: PROMOTION_KIND,
				targetKind: "user",
				targetId: "u-promoted",
				actorId: null,
			});
		}),
	);

	it.effect("with the bildirim flag OFF the write never happens (dark by default)", () =>
		notifyPromotion({userId: "u-promoted"}).pipe(
			Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(false))),
		),
	);

	it.effect("a DYING notification write is swallowed — the promotion caller still succeeds", () =>
		Effect.gen(function* () {
			const exit = yield* notifyPromotion({userId: "u-promoted"}).pipe(
				Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(true))),
				Effect.exit,
			);
			assert.strictEqual(exit._tag, "Success");
		}),
	);
});

describe("notifyBacklogRelease — the swept-backlog announcement (#7061)", () => {
	it.effect("records one row carrying the swept-entry count, with no actor identity", () =>
		Effect.gen(function* () {
			const calls: NotificationRecordInput[] = [];
			yield* notifyBacklogRelease({userId: "u-promoted", releasedCount: 3}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeNotificationStub({
							record: (input) => {
								calls.push(input);
								return Effect.succeed({id: "n1"});
							},
						}),
						requestContext(true),
					),
				),
			);
			assert.strictEqual(calls.length, 1);
			assert.deepStrictEqual(calls[0], {
				recipientId: "u-promoted",
				kind: BACKLOG_RELEASE_KIND,
				targetKind: "user",
				targetId: "u-promoted",
				actorId: null,
				count: 3,
			});
		}),
	);

	it.effect("a zero-entry sweep still records once — the copy's zero arm renders it", () =>
		Effect.gen(function* () {
			const calls: NotificationRecordInput[] = [];
			yield* notifyBacklogRelease({userId: "u-promoted", releasedCount: 0}).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeNotificationStub({
							record: (input) => {
								calls.push(input);
								return Effect.succeed({id: "n1"});
							},
						}),
						requestContext(true),
					),
				),
			);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0]?.count, 0);
		}),
	);

	it.effect("with the bildirim flag OFF the write never happens (dark by default)", () =>
		notifyBacklogRelease({userId: "u-promoted", releasedCount: 2}).pipe(
			Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(false))),
		),
	);

	it.effect("a DYING notification write is swallowed — the sweep caller still succeeds", () =>
		Effect.gen(function* () {
			const exit = yield* notifyBacklogRelease({userId: "u-promoted", releasedCount: 1}).pipe(
				Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(true))),
				Effect.exit,
			);
			assert.strictEqual(exit._tag, "Success");
		}),
	);
});
