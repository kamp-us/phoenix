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
import {Effect, Layer} from "effect";
import {Kunye} from "../kunye/Kunye.ts";
import {makeVouchLedgerStub} from "../kunye/VouchLedger.testing.ts";
import {makePasaportStub} from "./Pasaport.testing.ts";
import {resolveTandem} from "./tandem.ts";

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
					makePasaportStub({promoteToYazar: () => Effect.succeed({promoted: true})}),
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
				),
			),
		),
	);
});
