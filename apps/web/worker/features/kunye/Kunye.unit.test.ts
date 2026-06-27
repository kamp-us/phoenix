/**
 * `Kunye` standing reads (ADR 0107 §4): the pure karma→tier derivation across
 * every rank boundary, and `KunyeLive` reading `karma`/`tier` FRESH off the
 * pasaport profile surface (a scripted `lookupProfileById`) plus the v1
 * `rootOf` identity seam. The whole point is that standing comes from the karma
 * store at the point of use, never session state.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {makePasaportStub} from "../pasaport/Pasaport.testing.ts";
import type {ProfileRow} from "../pasaport/Pasaport.ts";
import {KARMA_THRESHOLDS, Kunye, KunyeLive, tierForKarma} from "./Kunye.ts";

const profile = (totalKarma: number): ProfileRow => ({
	userId: "u1",
	username: "u-one",
	displayName: "U One",
	image: null,
	totalKarma,
	definitionCount: 0,
	postCount: 0,
	commentCount: 0,
});

const kunyeOver = (row: ProfileRow | null): Layer.Layer<Kunye> =>
	KunyeLive.pipe(Layer.provide(makePasaportStub({lookupProfileById: () => Effect.succeed(row)})));

describe("tierForKarma", () => {
	it("is visitor below the çaylak floor", () => {
		assert.strictEqual(tierForKarma(KARMA_THRESHOLDS.çaylak - 1), "visitor");
		assert.strictEqual(tierForKarma(0), "visitor");
	});

	it("is çaylak from its floor up to the yazar floor", () => {
		assert.strictEqual(tierForKarma(KARMA_THRESHOLDS.çaylak), "çaylak");
		assert.strictEqual(tierForKarma(KARMA_THRESHOLDS.yazar - 1), "çaylak");
	});

	it("is yazar at and above the yazar floor", () => {
		assert.strictEqual(tierForKarma(KARMA_THRESHOLDS.yazar), "yazar");
		assert.strictEqual(tierForKarma(KARMA_THRESHOLDS.yazar + 1000), "yazar");
	});
});

describe("KunyeLive", () => {
	it.effect("karmaOf reads total_karma off the profile surface", () =>
		Effect.gen(function* () {
			const kunye = yield* Kunye;
			assert.strictEqual(yield* kunye.karmaOf("u1"), 42);
		}).pipe(Effect.provide(kunyeOver(profile(42)))),
	);

	it.effect("karmaOf is 0 when there is no profile row", () =>
		Effect.gen(function* () {
			const kunye = yield* Kunye;
			assert.strictEqual(yield* kunye.karmaOf("u1"), 0);
		}).pipe(Effect.provide(kunyeOver(null))),
	);

	it.effect("tierOf derives the rank from the fresh karma read", () =>
		Effect.gen(function* () {
			const kunye = yield* Kunye;
			assert.strictEqual(yield* kunye.tierOf("u1"), "yazar");
		}).pipe(Effect.provide(kunyeOver(profile(KARMA_THRESHOLDS.yazar)))),
	);

	it.effect("tierOf is visitor for an account with no standing", () =>
		Effect.gen(function* () {
			const kunye = yield* Kunye;
			assert.strictEqual(yield* kunye.tierOf("u1"), "visitor");
		}).pipe(Effect.provide(kunyeOver(null))),
	);

	it.effect("rootOf is the account itself in v1 (humans-only seam)", () =>
		Effect.gen(function* () {
			const kunye = yield* Kunye;
			assert.strictEqual(yield* kunye.rootOf("u1"), "u1");
		}).pipe(Effect.provide(kunyeOver(null))),
	);
});
