/**
 * Username-validation unit coverage (ADR 0082) — the `setUsername` input checks
 * that are wrong-or-right with NO database.
 *
 * `Pasaport.setUsername` runs `assertUsername(value.trim().toLowerCase())` BEFORE
 * its first DB read (the uniqueness / already-set lookups), so the length and
 * format rejections are pure logic on the input value — they could never be wrong
 * just because the database differed (ADR 0082 litmus). The reserved-`silinen`
 * branch of the same gate is pinned in `account-deletion.unit.test.ts`; this file
 * pins the other two non-reserved branches (too-short, illegal-format) over the
 * same throwing-`Drizzle` seam, so a reached read would `die` rather than surface
 * the typed error — which is the "no DB read" proof.
 *
 * The DB-state-dependent rejections of the same mutation (`TAKEN` against a
 * persisted row, `ALREADY_SET` against a persisted username) stay on real D1 in
 * `tests/integration/pasaport.test.ts` — those are only-wrong-if-the-DB-differs.
 */

import {it} from "@effect/vitest";
import {Cause, Effect, Exit, Layer} from "effect";
import {assert} from "vitest";
import {Drizzle, type DrizzleAccess} from "../../db/Drizzle.ts";
import {type BetterAuthInstance, makePasaportLive, Pasaport} from "./Pasaport.ts";

// Every DB call dies, so any path that reaches the seam fails the test: the
// length/format gate short-circuits before any read, and running to completion
// against this access is the "no read" proof.
const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("setUsername read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("setUsername wrote a batch on a path that must short-circuit")),
};

// `setUsername`'s validation gate uses neither the session nor the DB, so a
// never-cast inert instance satisfies the type.
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
