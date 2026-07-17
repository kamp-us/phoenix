/**
 * Rite-feedback emitter coverage (#1695) — the decisions that are wrong-or-right
 * with no database (ADR 0082 T1/T2; `.patterns/effect-testing.md`): recipient
 * resolution / self-suppression, the flag containment (dark by default), the
 * aggregate-vs-plain write routing, and the swallow-at-the-seam guarantee — a
 * DYING `Notification` (the `orDieAccess` defect shape) cannot fail the caller.
 * The `Notification` seam is the fail-on-contact stub with only the expected
 * method overridden, so "touched the wrong write surface" is a test failure.
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
	DIVAN_VOTE_KIND,
	KEFIL_KIND,
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

// A no-op `LivePublisher`: the emitters call `Notification.record`, which yields the
// per-request publisher for the fire-and-forget live fan-out (#1700). The emit path is
// swallowed and the stub `record` never touches it, so a do-nothing publisher satisfies
// the requirement without asserting anything on it (the live publish itself is covered
// in `Notification.unit.test.ts` / the integration tier).
const noopLivePublisher = Layer.succeed(LivePublisher)({
	update: () => Effect.void,
	delete: () => Effect.void,
	topic: () => {
		throw new Error("noopLivePublisher.topic unused");
	},
} as typeof LivePublisher.Service);

// A `Mute` returning no mutes: the divan-vote/kefil emitters now consult `bildirimMutedBy`,
// which reads `readMutedIds` — an empty set means no member is muted, so these cases exercise
// the unchanged (deliver) path. Muted-suppression itself is covered in mute-suppression.unit.test.ts.
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
				// raises on a D1 failure. The emitter must swallow it, not surface it.
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
