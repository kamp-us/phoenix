/**
 * `resolveTandem` coverage (#1289). The property under test: promotion is independent of
 * whether the vouch or the bar-crossing vote landed first. Each stub method NOT on the
 * path under test is fail-on-contact, so a case proves exactly which reads it touched.
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {makeNotificationStub} from "../bildirim/Notification.testing.ts";
import type {NotificationRecordInput} from "../bildirim/Notification.ts";
import {PROMOTION_KIND} from "../bildirim/rite-emitters.ts";
import {noRequestFlagOverrides} from "../fate/resolve-wire.testing.ts";
import {Flags} from "../flagship/Flags.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {makeVouchLedgerStub} from "../kunye/VouchLedger.testing.ts";
import {makePasaportStub} from "./Pasaport.testing.ts";
import {livePromoteContext} from "./promote-live.testing.ts";
import {NO_SANDBOX_SWEEP} from "./sandbox-sweep.ts";
import {resolveTandem} from "./tandem.ts";

// A landed flip re-resolves the promoted `User` (#1886), so the stub must answer
// `getUsersByIds`. `promoted: false` cases never reach it.
const promotedYazar = (id: string) =>
	makePasaportStub({
		promoteToYazar: () => Effect.succeed({promoted: true, sweep: NO_SANDBOX_SWEEP}),
		getUsersByIds: () =>
			Effect.succeed([
				{id, email: `${id}@kamp.us`, name: id, image: null, username: id, tier: "yazar" as const},
			]),
	});

// Flag-ON with a fail-on-contact Notification: the emit is swallowed at the seam, so a
// dying write can't fail these promotion cases (#1696). A case that ASSERTS on the emit
// passes its own recording stub instead.
const runtimeContextStub: BaseRuntimeContext = {
	Type: "tandem-test",
	id: "tandem-test",
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

const bildirimContext = (notification = makeNotificationStub(), on = true) =>
	Layer.mergeAll(
		notification,
		flagsStub(on),
		Layer.succeed(CurrentUser, {user: undefined}),
		Layer.succeed(RuntimeContext, runtimeContextStub),
		noRequestFlagOverrides,
	);

// `tierOf`/`rootOf` are unreached on the resolver path, so they fail-on-contact.
const kunyeKarma = (karma: number): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {
		karmaOf: () => Effect.succeed(karma),
		tierOf: () => Effect.die(new Error("resolveTandem must not read tier")),
		rootOf: (id: string) => Effect.succeed(id),
	});

const kunyeUnreached: Layer.Layer<Kunye> = Layer.succeed(Kunye, {
	karmaOf: () => Effect.die(new Error("resolveTandem must not read karma without an active vouch")),
	tierOf: () => Effect.die(new Error("resolveTandem must not read tier")),
	rootOf: (id: string) => Effect.succeed(id),
});

describe("resolveTandem — order-independent promotion", () => {
	// VOUCH-FIRST order: the vouch was placed below the bar, then a vote crosses it. This
	// is the case #1285's vouch-act-only re-eval missed.
	it.effect("vouch-first: an active vouch + a bar-crossing karma → promotes", () =>
		Effect.gen(function* () {
			const {promoted} = yield* resolveTandem("u-caylak");
			assert.strictEqual(promoted, true);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeVouchLedgerStub({hasActiveFor: () => Effect.succeed(true)}),
					kunyeKarma(20), // ≥ VOUCH_PROMOTION_KARMA_BAR (15)
					promotedYazar("u-caylak"),
					bildirimContext(),
					livePromoteContext,
				),
			),
		),
	);

	// An active vouch but karma still below the bar ⇒ no flip (Pasaport fail-on-contact).
	it.effect("an active vouch but karma below the bar does NOT promote", () =>
		Effect.gen(function* () {
			const {promoted} = yield* resolveTandem("u-caylak");
			assert.strictEqual(promoted, false);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeVouchLedgerStub({hasActiveFor: () => Effect.succeed(true)}),
					kunyeKarma(5), // below the bar
					makePasaportStub(),
					bildirimContext(),
					livePromoteContext,
				),
			),
		),
	);

	// The withdraw negative: the resolver short-circuits on the vouch half and never even
	// reads karma (Kunye fail-on-contact).
	it.effect("no active vouch (withdrawn) ⇒ a bar-crossing karma does NOT promote", () =>
		Effect.gen(function* () {
			const {promoted} = yield* resolveTandem("u-caylak");
			assert.strictEqual(promoted, false);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeVouchLedgerStub({hasActiveFor: () => Effect.succeed(false)}),
					kunyeUnreached,
					makePasaportStub(),
					bildirimContext(),
					livePromoteContext,
				),
			),
		),
	);

	// Idempotency: the guarded flip matches 0 rows for an already-yazar candidate, so a
	// vote after promotion can't double-promote.
	it.effect("re-firing over an already-yazar candidate is an idempotent no-op", () =>
		Effect.gen(function* () {
			const {promoted} = yield* resolveTandem("u-already-yazar");
			assert.strictEqual(promoted, false);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeVouchLedgerStub({hasActiveFor: () => Effect.succeed(true)}),
					kunyeKarma(50),
					makePasaportStub({
						promoteToYazar: () => Effect.succeed({promoted: false, sweep: NO_SANDBOX_SWEEP}),
					}),
					bildirimContext(),
					livePromoteContext,
				),
			),
		),
	);
});

// The emit is keyed on `promoted`: a landed flip emits ONE `terfi` bildirimi, an
// idempotent no-op flip emits nothing (#1696).
describe("resolveTandem — promotion ceremony bildirimi (#1696)", () => {
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

	it.effect("a landed flip emits one terfi notification for the promoted çaylak", () => {
		const {layer, emits} = promotionRecording();
		return Effect.gen(function* () {
			yield* resolveTandem("u-caylak");
			assert.deepStrictEqual(emits, [
				{
					recipientId: "u-caylak",
					kind: PROMOTION_KIND,
					targetKind: "user",
					targetId: "u-caylak",
					actorId: null,
				},
			]);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeVouchLedgerStub({hasActiveFor: () => Effect.succeed(true)}),
					kunyeKarma(20),
					promotedYazar("u-caylak"),
					bildirimContext(layer),
					livePromoteContext,
				),
			),
		);
	});

	it.effect("an already-yazar no-op flip emits nothing", () => {
		const {layer, emits} = promotionRecording();
		return Effect.gen(function* () {
			yield* resolveTandem("u-already-yazar");
			assert.deepStrictEqual(emits, []);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeVouchLedgerStub({hasActiveFor: () => Effect.succeed(true)}),
					kunyeKarma(50),
					makePasaportStub({
						promoteToYazar: () => Effect.succeed({promoted: false, sweep: NO_SANDBOX_SWEEP}),
					}),
					bildirimContext(layer),
					livePromoteContext,
				),
			),
		);
	});
});
