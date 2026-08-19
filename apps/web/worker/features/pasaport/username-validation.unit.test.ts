/**
 * The `setUsername` input checks that are wrong-or-right with NO database (ADR 0082).
 * Every `Drizzle` call dies, so a typed error rather than a die is the "no DB read"
 * proof. The reserved-`silinen` branch is pinned in `account-deletion.unit.test.ts`.
 *
 * The DB-state-dependent rejections (`TAKEN`, `ALREADY_SET`) stay on real D1 in
 * `tests/integration/pasaport.test.ts`.
 */

import {it} from "@effect/vitest";
import {Cause, Effect, Exit, Layer} from "effect";
import {assert} from "vitest";
import {Drizzle, type DrizzleAccess} from "../../db/Drizzle.ts";
import {type BetterAuthInstance, makePasaportLive, Pasaport} from "./Pasaport.ts";

const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("setUsername read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("setUsername wrote a batch on a path that must short-circuit")),
};

// The validation gate uses neither the session nor the DB, so an inert cast suffices.
const inertAuth = {} as BetterAuthInstance;

const pasaportLayer = makePasaportLive(inertAuth).pipe(
	Layer.provide(Layer.succeed(Drizzle, throwingAccess)),
);

const expectTag = (exit: Exit.Exit<unknown, unknown>, tag: string) => {
	assert.isTrue(Exit.isFailure(exit), "expected setUsername to fail");
	if (Exit.isFailure(exit)) {
		const error = Cause.findErrorOption(exit.cause);
		assert.isTrue(error._tag === "Some", "expected a typed failure, not a die");
		if (error._tag === "Some") {
			assert.strictEqual((error.value as {_tag: string})._tag, tag);
		}
	}
};

it.effect("a too-short username rejects with UsernameTooShort, no DB read", () =>
	Effect.gen(function* () {
		const pasaport = yield* Pasaport;
		const exit = yield* pasaport.setUsername({userId: "u1", value: "ab"}).pipe(Effect.exit);
		expectTag(exit, "pasaport/UsernameTooShort");
	}).pipe(Effect.provide(pasaportLayer)),
);

it.effect("an over-long username rejects with UsernameTooLong, no DB read", () =>
	Effect.gen(function* () {
		const pasaport = yield* Pasaport;
		const exit = yield* pasaport
			.setUsername({userId: "u1", value: "a".repeat(31)})
			.pipe(Effect.exit);
		expectTag(exit, "pasaport/UsernameTooLong");
	}).pipe(Effect.provide(pasaportLayer)),
);

it.effect("an illegal-format username rejects with UsernameInvalidFormat, no DB read", () =>
	Effect.gen(function* () {
		const pasaport = yield* Pasaport;
		const exit = yield* pasaport.setUsername({userId: "u1", value: "Bad_Name!"}).pipe(Effect.exit);
		expectTag(exit, "pasaport/UsernameInvalidFormat");
	}).pipe(Effect.provide(pasaportLayer)),
);
