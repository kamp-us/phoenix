/**
 * `resolveTandem` coverage (#1289) — the order-independent tandem resolver, the single
 * promotion code path BOTH triggers share (the vouch act `user.vouch`, and the karma
 * side a vote-on-sandboxed #1288 will call). These cases pin the correctness property
 * that promotion is independent of whether the vouch or the bar-crossing vote landed
 * first, plus the negative (no active vouch ⇒ no promotion) and idempotency (a re-fire
 * over an already-yazar candidate is a safe no-op).
 *
 * The three ports are scripted stubs (`VouchLedger` the vouch half, `Kunye` the karma
 * half, `Pasaport` the atomic flip) — no DB; the real-D1 fidelity of the ledger queries
 * and the atomic promotion batch is the integration tier. Each stub method NOT on the
 * path under test is fail-on-contact, so a case proves exactly which reads it touched
 * (e.g. the no-vouch case never reads karma).
 */
import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {type BaseRuntimeContext, RuntimeContext} from "alchemy";
import {Effect, Layer} from "effect";
import {makeNotificationStub} from "../bildirim/Notification.testing.ts";
import type {NotificationRecordInput} from "../bildirim/Notification.ts";
import {PROMOTION_KIND} from "../bildirim/rite-emitters.ts";
import {Flags} from "../flagship/Flags.ts";
import {Kunye} from "../kunye/Kunye.ts";
import {makeVouchLedgerStub} from "../kunye/VouchLedger.testing.ts";
import {makePasaportStub} from "./Pasaport.testing.ts";
import {livePromoteContext} from "./promote-live.testing.ts";
import {resolveTandem} from "./tandem.ts";

// A landed flip (`promoted: true`) re-resolves the promoted `User` (#1886), so its
// stub must answer `getUsersByIds` (the record the flip promoted, now `yazar`) —
// the publish's inline data. `promoted: false` cases never reach it (unchanged).
const promotedYazar = (id: string) =>
	makePasaportStub({
		promoteToYazar: () => Effect.succeed({promoted: true}),
		getUsersByIds: () =>
			Effect.succeed([
				{id, email: `${id}@kamp.us`, name: id, image: null, username: id, tier: "yazar" as const},
			]),
	});

// resolveTandem emits the promotion-ceremony bildirimi on a landed flip (#1696), so
// it now needs the bildirim seam (Notification + Flags + CurrentUser + RuntimeContext)
// in R. The default `bildirimContext` provides a flag-ON, fail-on-contact Notification
// (the emit is swallowed at the seam, so a DYING write can't fail these promotion cases)
// — a case that ASSERTS on the emit passes its own recording Notification stub instead.
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
	);

// A `Kunye` whose `karmaOf` answers `karma`; `tierOf`/`rootOf` are unreached on the
// resolver path (it reads karma only), so they fail-on-contact.
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
	// VOUCH-FIRST order: the vouch was already placed below the bar; now a vote crosses
	// the bar and the karma side fires the resolver → promote. This is the case #1285's
	// vouch-act-only re-eval misses; the karma-side trigger is what closes it.
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

	// The withdraw negative: with no active vouch (the only one was withdrawn before the
	// bar was crossed), a bar-crossing karma is inert — the resolver short-circuits on the
	// vouch half and never even reads karma (Kunye fail-on-contact) or promotes.
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

	// Idempotency: both halves hold but the candidate is already a yazar, so the guarded
	// flip matches 0 rows (`promoted:false`). Re-firing the resolver is a safe no-op — the
	// property the karma side relies on (a vote after promotion can't double-promote).
	it.effect("re-firing over an already-yazar candidate is an idempotent no-op", () =>
		Effect.gen(function* () {
			const {promoted} = yield* resolveTandem("u-already-yazar");
			assert.strictEqual(promoted, false);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					makeVouchLedgerStub({hasActiveFor: () => Effect.succeed(true)}),
					kunyeKarma(50),
					makePasaportStub({promoteToYazar: () => Effect.succeed({promoted: false})}),
					bildirimContext(),
					livePromoteContext,
				),
			),
		),
	);
});

// Promotion ceremony (#1696): a landed tandem flip emits ONE `terfi` bildirimi to the
// promoted çaylak (recipient = the çaylak's own account, no actor identity); an
// idempotent no-op flip (already-yazar) emits nothing — the emit is keyed on `promoted`.
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
					makePasaportStub({promoteToYazar: () => Effect.succeed({promoted: false})}),
					bildirimContext(layer),
					livePromoteContext,
				),
			),
		);
	});
});
