/**
 * Vote-emitter coverage (#1698) — the decisions that are wrong-or-right with no
 * database (ADR 0082 T1/T2; `.patterns/effect-testing.md`): recipient resolution /
 * self-suppression, the flag containment (dark by default), the aggregate write
 * routing ("N yeni oy", never one-per-vote), and the swallow-at-the-seam guarantee —
 * a DYING `Notification` (the `orDieAccess` defect shape) cannot fail the caller.
 * The `Notification` seam is the fail-on-contact stub with only the expected method
 * overridden, so "touched the wrong write surface" (e.g. `record` instead of
 * `recordAggregate`) is a test failure.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser, LivePublisher} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {noRequestFlagOverrides} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {Mute} from "../mute/Mute.ts";
import {makeNotificationStub} from "./Notification.testing.ts";
import type {NotificationAggregateInput} from "./Notification.ts";
import {notifyContentVote, VOTE_KIND, voteRecipient} from "./vote-emitters.ts";

const runtimeContextStub: BaseRuntimeContext = {
	Type: "vote-emitters-test",
	id: "vote-emitters-test",
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

// A no-op `LivePublisher`: `Notification.record`/`recordAggregate` yield the
// per-request publisher for the fire-and-forget live fan-out (#1700, PR #2076). The
// `Notification` seam is a stub here, so a do-nothing publisher satisfies the
// requirement without asserting on it (the live publish is covered at the spine /
// integration tier). Mirrors the rite-emitters test context.
const noopLivePublisher = Layer.succeed(LivePublisher)({
	update: () => Effect.void,
	delete: () => Effect.void,
	topic: () => {
		throw new Error("noopLivePublisher.topic unused");
	},
} as typeof LivePublisher.Service);

// A `Mute` returning no mutes: the emitters now consult `bildirimMutedBy`, which reads
// `readMutedIds` — an empty set means no member is muted, so these cases exercise the
// unchanged (deliver) path. Muted-suppression itself is covered in mute-suppression.unit.test.ts.
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

describe("voteRecipient — self-suppression, pure", () => {
	it("resolves the author when voter and author differ", () => {
		assert.strictEqual(voteRecipient("u-author", "u-voter"), "u-author");
	});
	it("suppresses when the voter IS the author", () => {
		assert.strictEqual(voteRecipient("u-author", "u-author"), null);
	});
});

describe("notifyContentVote — the aggregated live-content vote emit", () => {
	it.effect("routes through recordAggregate with the author recipient and NO actor identity", () =>
		Effect.gen(function* () {
			const calls: NotificationAggregateInput[] = [];
			yield* notifyContentVote({
				authorId: "u-author",
				voterId: "u-voter",
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
				kind: VOTE_KIND,
				targetKind: "post",
				targetId: "p1",
				actorId: null,
			});
		}),
	);

	it.effect("aggregates repeat votes on one item into the SAME upsert key (roll-up)", () =>
		Effect.gen(function* () {
			const calls: NotificationAggregateInput[] = [];
			const stub = makeNotificationStub({
				recordAggregate: (input) => {
					calls.push(input);
					// second+ emit reports the bump — the emitter never mints a row per vote
					return Effect.succeed({aggregated: calls.length > 1});
				},
			});
			for (let i = 0; i < 3; i++) {
				yield* notifyContentVote({
					authorId: "u-author",
					voterId: `u-voter-${i}`,
					targetKind: "definition",
					targetId: "d1",
				}).pipe(Effect.provide(Layer.mergeAll(stub, requestContext(true))));
			}
			// three votes → three emits, all carrying the SAME (recipient, kind, target)
			// aggregate key with no per-voter identity — the spine rolls them into one row.
			assert.strictEqual(calls.length, 3);
			for (const c of calls) {
				assert.deepStrictEqual(c, {
					recipientId: "u-author",
					kind: VOTE_KIND,
					targetKind: "definition",
					targetId: "d1",
					actorId: null,
				});
			}
		}),
	);

	it.effect("covers all three live target kinds", () =>
		Effect.gen(function* () {
			const calls: NotificationAggregateInput[] = [];
			const stub = makeNotificationStub({
				recordAggregate: (input) => {
					calls.push(input);
					return Effect.succeed({aggregated: false});
				},
			});
			for (const targetKind of ["post", "comment", "definition"] as const) {
				yield* notifyContentVote({
					authorId: "u-author",
					voterId: "u-voter",
					targetKind,
					targetId: `${targetKind}-1`,
				}).pipe(Effect.provide(Layer.mergeAll(stub, requestContext(true))));
			}
			assert.deepStrictEqual(
				calls.map((c) => c.targetKind),
				["post", "comment", "definition"],
			);
		}),
	);

	it.effect("a self-vote emits nothing (the fail-on-contact stub is never touched)", () =>
		notifyContentVote({
			authorId: "u-author",
			voterId: "u-author",
			targetKind: "post",
			targetId: "p1",
		}).pipe(Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(true)))),
	);

	it.effect("with the bildirim flag OFF the write never happens (dark by default)", () =>
		notifyContentVote({
			authorId: "u-author",
			voterId: "u-voter",
			targetKind: "post",
			targetId: "p1",
		}).pipe(Effect.provide(Layer.mergeAll(makeNotificationStub(), requestContext(false)))),
	);

	it.effect(
		"a DYING notification write is swallowed — the vote caller still succeeds (the seam AC)",
		() =>
			Effect.gen(function* () {
				// The default stub DIES on contact — the exact defect shape `orDieAccess`
				// raises on a D1 failure. The emitter must swallow it, not surface it, so a
				// notification hiccup can never fail the committed vote mutation (ADR 0039).
				const exit = yield* notifyContentVote({
					authorId: "u-author",
					voterId: "u-voter",
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
