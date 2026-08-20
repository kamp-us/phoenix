/**
 * `user.promote` / `user.vouch` WIRE-boundary coverage (#1206, ADR 0082): driven through
 * `resolveWire` so a denial's wire `code` is what a client actually gets and a
 * mis-annotated `[FateWireCode]` is a unit failure.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type Actor,
	AgentAuthority,
	CurrentActor,
	human,
	RelationStore,
	unauthenticated,
} from "@kampus/authz";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Cause, Effect, Exit, Layer} from "effect";
import {makeNotificationStub} from "../bildirim/Notification.testing.ts";
import type {NotificationRecordInput} from "../bildirim/Notification.ts";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {Kunye} from "../kunye/Kunye.ts";
import type {Tier} from "../kunye/standing.ts";
import {makeVouchLedgerStub} from "../kunye/VouchLedger.testing.ts";
import {Mute} from "../mute/Mute.ts";
import {mutations} from "./mutations.ts";
import {makePasaportStub} from "./Pasaport.testing.ts";
import {noopLive, relationStoreNoModerators} from "./promote-live.testing.ts";
import {NO_SANDBOX_SWEEP} from "./sandbox-sweep.ts";

// A landed flip re-resolves the promoted `User` for the #1886 live-publish, so a
// `promoted: true` stub must answer `getUsersByIds`.
const promotedUsersByIds = (id: string) => ({
	getUsersByIds: () =>
		Effect.succeed([
			{id, email: `${id}@kamp.us`, name: id, image: null, username: id, tier: "yazar" as const},
		]),
});

const runtimeContextStub: BaseRuntimeContext = {
	Type: "promotion-test",
	id: "promotion-test",
	env: {},
	get: () => Effect.succeed(undefined),
	set: (id) => Effect.succeed(id),
};

// The kefil/terfi emitters read the `phoenix-bildirim` flag, so every case needs Flags —
// on, so the deliver path runs.
const flagsOn: Layer.Layer<Flags> = Layer.succeed(
	Flags,
	// biome-ignore lint/plugin: a Flags test double — only getBoolean is exercised here.
	{
		getBoolean: () => Effect.succeed(true),
		getString: () => Effect.die(new Error("unused")),
		getNumber: () => Effect.die(new Error("unused")),
		getObject: () => Effect.die(new Error("unused")),
	} as unknown as typeof Flags.Service,
);

const agentAuthorityStub = Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(false)});

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

const kunyeOf = (
	tierById: Record<string, Tier>,
	karmaById: Record<string, number>,
): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {
		tierOf: (id: string) => Effect.succeed(tierById[id] ?? "visitor"),
		karmaOf: (id: string) => Effect.succeed(karmaById[id] ?? 0),
		rootOf: (id: string) => Effect.succeed(id),
	});

// `LivePublisher` is a static requirement of EVERY case, even a denial that never runs
// the flip. The kefil emit consults `bildirimMutedBy` (#3238), so `Mute` is required too;
// an empty set means nobody is muted and the deliver path is unchanged.
const noMutes = Layer.succeed(Mute, {
	set: () => Effect.die("Mute.set not exercised"),
	listMine: () => Effect.die("Mute.listMine not exercised"),
	readMutedIds: () => Effect.succeed(new Set<string>()),
});

const requestContext = (actor: Actor) =>
	Layer.mergeAll(flagsOn, noopLive, noMutes).pipe(
		Layer.provideMerge(Layer.succeed(CurrentUser, {user: undefined})),
		Layer.provideMerge(Layer.succeed(CurrentActor, {actor})),
		Layer.provideMerge(Layer.succeed(RuntimeContext, runtimeContextStub)),
	);

const promote = (userId: string) =>
	resolveWire(mutations["user.promote"], {
		input: {userId},
		select: ["userId", "promoted", "vouchRecorded"],
	});

const vouch = (candidateId: string) =>
	resolveWire(mutations["user.vouch"], {
		input: {candidateId},
		select: ["userId", "promoted", "vouchRecorded"],
	});

const withdrawVouch = (candidateId: string) =>
	resolveWire(mutations["user.withdrawVouch"], {
		input: {candidateId},
		select: ["userId", "promoted", "vouchRecorded"],
	});

const wireCodeOf = (cause: Cause.Cause<unknown>): unknown => {
	const error = Cause.findErrorOption(cause);
	return error._tag === "Some" ? (error.value as {code?: unknown}).code : undefined;
};

describe("user.promote — direct moderator promotion", () => {
	it.effect("a moderator promotes a çaylak; the tier flip is server-enforced", () =>
		Effect.gen(function* () {
			const receipt = yield* promote("u-target");
			assert.strictEqual((receipt as {promoted: boolean}).promoted, true);
			assert.strictEqual((receipt as {vouchRecorded: boolean}).vouchRecorded, false);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub({
						promoteToYazar: () => Effect.succeed({promoted: true, sweep: NO_SANDBOX_SWEEP}),
						...promotedUsersByIds("u-target"),
					}),
					relationStoreOf(["u-mod"]),
					agentAuthorityStub,
					makeNotificationStub({record: () => Effect.succeed({id: "n-test"})}),
					requestContext(human("u-mod")),
					noopLive,
				),
			),
		),
	);

	it.effect("a non-moderator gets the invisible UNAUTHORIZED — and never reaches the write", () =>
		Effect.gen(function* () {
			const exit = yield* promote("u-target").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "UNAUTHORIZED");
		}).pipe(
			// Pasaport fail-on-contact: a reached promote would die, proving no self-promote write.
			Effect.provide(
				Layer.mergeAll(
					makePasaportStub(),
					relationStoreOf(["someone-else"]),
					agentAuthorityStub,
					makeNotificationStub({record: () => Effect.succeed({id: "n-test"})}),
					requestContext(human("u-rando")),
				),
			),
		),
	);
});

describe("user.vouch — author-vouch tandem", () => {
	const yazarVoucher = {tier: {"u-yazar": "yazar"} as Record<string, Tier>};

	it.effect(
		"karma-first: vouch with karma already over the bar promotes; the vouch is recorded (actor preserved)",
		() =>
			Effect.gen(function* () {
				const receipt = yield* vouch("u-caylak");
				assert.strictEqual((receipt as {promoted: boolean}).promoted, true);
				assert.strictEqual((receipt as {vouchRecorded: boolean}).vouchRecorded, true);
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						relationStoreNoModerators,
						makePasaportStub({
							promoteToYazar: () => Effect.succeed({promoted: true, sweep: NO_SANDBOX_SWEEP}),
							...promotedUsersByIds("u-caylak"),
						}),
						makeVouchLedgerStub({
							castVouch: () => Effect.succeed({outcome: "recorded" as const}),
							hasActiveFor: () => Effect.succeed(true),
						}),
						kunyeOf(yazarVoucher.tier, {"u-caylak": 25}), // above VOUCH_PROMOTION_KARMA_BAR
						agentAuthorityStub,
						makeNotificationStub({record: () => Effect.succeed({id: "n-test"})}),
						requestContext(human("u-yazar")),
						noopLive,
					),
				),
			),
	);

	it.effect("below the reduced bar the vouch is recorded but NO tier flips (the tandem)", () =>
		Effect.gen(function* () {
			const receipt = yield* vouch("u-caylak");
			assert.strictEqual((receipt as {promoted: boolean}).promoted, false);
			assert.strictEqual((receipt as {vouchRecorded: boolean}).vouchRecorded, true);
		}).pipe(
			// Pasaport fail-on-contact: a reached promote below the bar would die.
			Effect.provide(
				Layer.mergeAll(
					relationStoreNoModerators,
					makePasaportStub(),
					makeVouchLedgerStub({
						castVouch: () => Effect.succeed({outcome: "recorded" as const}),
						hasActiveFor: () => Effect.succeed(true),
					}),
					kunyeOf(yazarVoucher.tier, {"u-caylak": 1}), // below the bar
					agentAuthorityStub,
					makeNotificationStub({record: () => Effect.succeed({id: "n-test"})}),
					requestContext(human("u-yazar")),
				),
			),
		),
	);

	// The default `has`/`activeCountFor` stay fail-on-contact, proving the resolver no
	// longer re-derives the cap from the active count (#1362).
	it.effect("a yazar at the concurrent-vouch cap is denied a 4th — VOUCH_LIMIT_REACHED", () =>
		Effect.gen(function* () {
			const exit = yield* vouch("u-fourth").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "VOUCH_LIMIT_REACHED");
		}).pipe(
			// hasActiveFor + Pasaport fail-on-contact: a denied vouch never reaches the tandem.
			Effect.provide(
				Layer.mergeAll(
					relationStoreNoModerators,
					makePasaportStub(),
					makeVouchLedgerStub({
						castVouch: () => Effect.succeed({outcome: "capReached" as const}),
					}),
					kunyeOf(yazarVoucher.tier, {}),
					agentAuthorityStub,
					makeNotificationStub({record: () => Effect.succeed({id: "n-test"})}),
					requestContext(human("u-yazar")),
				),
			),
		),
	);

	it.effect("re-vouching an already-vouched candidate is allowed (idempotent, no fresh slot)", () =>
		Effect.gen(function* () {
			const receipt = yield* vouch("u-existing");
			assert.strictEqual((receipt as {vouchRecorded: boolean}).vouchRecorded, false);
			assert.strictEqual((receipt as {promoted: boolean}).promoted, false);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					relationStoreNoModerators,
					makePasaportStub(),
					makeVouchLedgerStub({
						castVouch: () => Effect.succeed({outcome: "alreadyVouched" as const}),
						hasActiveFor: () => Effect.succeed(true),
					}),
					kunyeOf(yazarVoucher.tier, {"u-existing": 1}), // below the bar ⇒ no promote
					agentAuthorityStub,
					makeNotificationStub({record: () => Effect.succeed({id: "n-test"})}),
					requestContext(human("u-yazar")),
				),
			),
		),
	);

	it.effect(
		"a çaylak cannot vouch — public FORBIDDEN, no record, no write (no self-promotion)",
		() =>
			Effect.gen(function* () {
				const exit = yield* vouch("u-anyone").pipe(Effect.exit);
				assert.isTrue(Exit.isFailure(exit));
				if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "FORBIDDEN");
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						relationStoreNoModerators,
						makePasaportStub(),
						makeVouchLedgerStub(),
						kunyeOf({"u-caylak-actor": "çaylak"}, {}),
						agentAuthorityStub,
						makeNotificationStub({record: () => Effect.succeed({id: "n-test"})}),
						requestContext(human("u-caylak-actor")),
					),
				),
			),
	);

	it.effect("an anonymous actor cannot vouch — FORBIDDEN", () =>
		Effect.gen(function* () {
			const exit = yield* vouch("u-anyone").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "FORBIDDEN");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					relationStoreNoModerators,
					makePasaportStub(),
					makeVouchLedgerStub(),
					kunyeOf({}, {}),
					agentAuthorityStub,
					makeNotificationStub({record: () => Effect.succeed({id: "n-test"})}),
					requestContext(unauthenticated),
				),
			),
		),
	);
});

describe("user.withdrawVouch — releasing the slot", () => {
	const yazarVoucher = {tier: {"u-yazar": "yazar"} as Record<string, Tier>};

	it.effect("a yazar withdraws their vouch (deletes the row); the ack never promotes", () =>
		Effect.gen(function* () {
			const receipt = yield* withdrawVouch("u-caylak");
			assert.strictEqual((receipt as {promoted: boolean}).promoted, false);
			assert.strictEqual((receipt as {vouchRecorded: boolean}).vouchRecorded, false);
		}).pipe(
			// Pasaport fail-on-contact: withdraw must never touch the promotion path.
			Effect.provide(
				Layer.mergeAll(
					relationStoreNoModerators,
					makePasaportStub(),
					makeVouchLedgerStub({withdraw: () => Effect.succeed({withdrawn: true})}),
					kunyeOf(yazarVoucher.tier, {}),
					agentAuthorityStub,
					makeNotificationStub({record: () => Effect.succeed({id: "n-test"})}),
					requestContext(human("u-yazar")),
				),
			),
		),
	);

	it.effect("a çaylak cannot withdraw a vouch — public FORBIDDEN, no write", () =>
		Effect.gen(function* () {
			const exit = yield* withdrawVouch("u-anyone").pipe(Effect.exit);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) assert.strictEqual(wireCodeOf(exit.cause), "FORBIDDEN");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					relationStoreNoModerators,
					makePasaportStub(),
					makeVouchLedgerStub(),
					kunyeOf({"u-caylak-actor": "çaylak"}, {}),
					agentAuthorityStub,
					makeNotificationStub({record: () => Effect.succeed({id: "n-test"})}),
					requestContext(human("u-caylak-actor")),
				),
			),
		),
	);
});

describe("user.vouch — kefil bildirimi (#1695)", () => {
	const yazarVoucher = {tier: {"u-yazar": "yazar"} as Record<string, Tier>};

	const kefilRecording = () => {
		const emits: NotificationRecordInput[] = [];
		const layer = makeNotificationStub({
			record: (input) => {
				emits.push(input);
				return Effect.succeed({id: "n-kefil"});
			},
		});
		return {layer, emits};
	};

	const vouchLayers = (
		notification: ReturnType<typeof makeNotificationStub>,
		outcome: "recorded" | "alreadyVouched",
	) =>
		Layer.mergeAll(
			relationStoreNoModerators,
			makePasaportStub(),
			makeVouchLedgerStub({
				castVouch: () => Effect.succeed({outcome}),
				hasActiveFor: () => Effect.succeed(true),
			}),
			kunyeOf(yazarVoucher.tier, {"u-caylak": 1}), // below the bar ⇒ no promote arm
			agentAuthorityStub,
			notification,
			requestContext(human("u-yazar")),
		);

	it.effect("a recorded vouch emits ONE kefil notification for the vouched çaylak", () => {
		const {layer, emits} = kefilRecording();
		return Effect.gen(function* () {
			yield* vouch("u-caylak");
			assert.deepStrictEqual(emits, [
				{
					recipientId: "u-caylak",
					kind: "kefil",
					targetKind: "user",
					targetId: "u-caylak",
					actorId: "u-yazar",
				},
			]);
		}).pipe(Effect.provide(vouchLayers(layer, "recorded")));
	});

	it.effect("an idempotent re-vouch (alreadyVouched) emits nothing", () => {
		const {layer, emits} = kefilRecording();
		return Effect.gen(function* () {
			yield* vouch("u-caylak");
			assert.deepStrictEqual(emits, []);
		}).pipe(Effect.provide(vouchLayers(layer, "alreadyVouched")));
	});

	it.effect("a DYING notification write cannot fail the committed vouch (the seam AC)", () =>
		Effect.gen(function* () {
			// fail-on-contact Notification: `record` DIES; the vouch receipt still lands.
			const receipt = yield* vouch("u-caylak");
			assert.strictEqual((receipt as {vouchRecorded: boolean}).vouchRecorded, true);
		}).pipe(Effect.provide(vouchLayers(makeNotificationStub(), "recorded"))),
	);
});

describe("user.promote — terfi bildirimi (#1696)", () => {
	const promotionRecording = () => {
		const emits: NotificationRecordInput[] = [];
		const layer = makeNotificationStub({
			record: (input) => {
				emits.push(input);
				return Effect.succeed({id: "n-terfi"});
			},
		});
		return {layer, emits};
	};

	const promoteLayers = (
		notification: ReturnType<typeof makeNotificationStub>,
		promoted: boolean,
	) =>
		Layer.mergeAll(
			makePasaportStub({
				promoteToYazar: () => Effect.succeed({promoted, sweep: NO_SANDBOX_SWEEP}),
				...promotedUsersByIds("u-target"),
			}),
			relationStoreOf(["u-mod"]),
			agentAuthorityStub,
			notification,
			requestContext(human("u-mod")),
			noopLive,
		);

	it.effect("a landed mod promotion emits ONE terfi notification for the promoted member", () => {
		const {layer, emits} = promotionRecording();
		return Effect.gen(function* () {
			yield* promote("u-target");
			assert.deepStrictEqual(emits, [
				{
					recipientId: "u-target",
					kind: "terfi",
					targetKind: "user",
					targetId: "u-target",
					actorId: null,
				},
			]);
		}).pipe(Effect.provide(promoteLayers(layer, true)));
	});

	it.effect("a no-op promotion (already-yazar) emits nothing", () => {
		const {layer, emits} = promotionRecording();
		return Effect.gen(function* () {
			yield* promote("u-target");
			assert.deepStrictEqual(emits, []);
		}).pipe(Effect.provide(promoteLayers(layer, false)));
	});

	it.effect("a DYING notification write cannot fail the committed promotion (the seam AC)", () =>
		Effect.gen(function* () {
			// fail-on-contact Notification: `record` DIES; the promotion receipt still lands.
			const receipt = yield* promote("u-target");
			assert.strictEqual((receipt as {promoted: boolean}).promoted, true);
		}).pipe(Effect.provide(promoteLayers(makeNotificationStub(), true))),
	);
});
