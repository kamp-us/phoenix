/**
 * `Kunye` standing reads (ADR 0107 §4):
 *   - `tierForKarma` — the pure karma→tier derivation across every rank boundary
 *     (retired from `tierOf`, now the promotion/karma children's input).
 *   - `KunyeLive.tierOf` — reads the **stored `user.tier` column** FRESH off pasaport
 *     (a scripted `getUserById`): an account is its stored `çaylak | yazar`, a
 *     no-account principal is `visitor`. The whole point is that standing comes from
 *     D1 at the point of use, never session state.
 *   - `KunyeLive.karmaOf` — reads `total_karma` off the profile surface.
 *   - `rootOf` — the v1 humans-only identity seam.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer} from "effect";
import {makePasaportStub} from "../pasaport/Pasaport.testing.ts";
import type {ProfileRow, UserRow} from "../pasaport/Pasaport.ts";
import {KARMA_THRESHOLDS, Kunye, KunyeLive, type StoredTier, tierForKarma} from "./Kunye.ts";

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

const userRow = (tier: StoredTier): UserRow => ({
	id: "u1",
	email: "u-one@example.com",
	name: "U One",
	image: null,
	username: "u-one",
	role: "member",
	tier,
});

/** Stub the karma surface (`lookupProfileById`) for the `karmaOf` reads. */
const kunyeOverProfile = (row: ProfileRow | null): Layer.Layer<Kunye> =>
	KunyeLive.pipe(Layer.provide(makePasaportStub({lookupProfileById: () => Effect.succeed(row)})));

/** Stub the stored-tier surface (`getUserById`) for the `tierOf` reads. */
const kunyeOverUser = (row: UserRow | null): Layer.Layer<Kunye> =>
	KunyeLive.pipe(Layer.provide(makePasaportStub({getUserById: () => Effect.succeed(row)})));

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
		}).pipe(Effect.provide(kunyeOverProfile(profile(42)))),
	);

	it.effect("karmaOf is 0 when there is no profile row", () =>
		Effect.gen(function* () {
			const kunye = yield* Kunye;
			assert.strictEqual(yield* kunye.karmaOf("u1"), 0);
		}).pipe(Effect.provide(kunyeOverProfile(null))),
	);

	it.effect("tierOf reads çaylak off the stored user.tier column", () =>
		Effect.gen(function* () {
			const kunye = yield* Kunye;
			assert.strictEqual(yield* kunye.tierOf("u1"), "çaylak");
		}).pipe(Effect.provide(kunyeOverUser(userRow("çaylak")))),
	);

	it.effect("tierOf reads yazar off the stored user.tier column", () =>
		Effect.gen(function* () {
			const kunye = yield* Kunye;
			assert.strictEqual(yield* kunye.tierOf("u1"), "yazar");
		}).pipe(Effect.provide(kunyeOverUser(userRow("yazar")))),
	);

	it.effect("tierOf is visitor when there is no account row", () =>
		Effect.gen(function* () {
			const kunye = yield* Kunye;
			assert.strictEqual(yield* kunye.tierOf("u1"), "visitor");
		}).pipe(Effect.provide(kunyeOverUser(null))),
	);

	it.effect("rootOf is the account itself in v1 (humans-only seam)", () =>
		Effect.gen(function* () {
			const kunye = yield* Kunye;
			assert.strictEqual(yield* kunye.rootOf("u1"), "u1");
		}).pipe(Effect.provide(kunyeOverUser(null))),
	);
});
