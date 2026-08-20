/**
 * Account-deletion unit coverage (ADR 0097) — the three decisions that are
 * wrong-or-right with NO database (ADR 0082): the typed-confirmation decode gate, the
 * caller-is-target invariant (there is no target parameter, so "delete user X" is
 * unrepresentable), and the reserved-username rejection before any DB read.
 *
 * The anonymize teardown itself is real-D1 fidelity →
 * `tests/integration/account-deletion.test.ts`.
 */

import {it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {Cause, Effect, Exit, Layer} from "effect";
import * as Schema from "effect/Schema";
import {assert} from "vitest";
import {Drizzle, type DrizzleAccess} from "../../db/Drizzle.ts";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {ACCOUNT_DELETE_CONFIRMATION, mutations} from "./mutations.ts";
import {type BetterAuthInstance, makePasaportLive, Pasaport} from "./Pasaport.ts";

// A `Drizzle` whose every call throws. Running to completion against it is exactly
// the "the guard short-circuited before any read" proof.
const throwingAccess: DrizzleAccess = {
	run: () => Effect.die(new Error("Pasaport read the DB on a path that must short-circuit")),
	batch: () => Effect.die(new Error("Pasaport wrote a batch on a path that must short-circuit")),
};

// `auth` is unused by the reserved-username guard, which short-circuits first.
const inertAuth = {} as BetterAuthInstance;

const pasaportLayer = (access: DrizzleAccess) =>
	makePasaportLive(inertAuth).pipe(Layer.provide(Layer.succeed(Drizzle, access)));

// Fail-on-contact `Pasaport`: a passing anon-gate test proves the mutation never
// reached the service (a reached call would `die`, not surface `Unauthorized`).
const failOnContactPasaport = {
	anonymizeAccount: () =>
		Effect.die("Pasaport.anonymizeAccount must not be reached on the anon gate"),
} as never;

const inputSchema = mutations["account.delete"].definition.input;
const decodeInput = Schema.decodeUnknownExit(inputSchema);

it("the typed confirmation accepts ONLY the exact phrase", () => {
	const ok = decodeInput({confirmation: ACCOUNT_DELETE_CONFIRMATION});
	assert.isTrue(Exit.isSuccess(ok));
});

it("an absent confirmation fails input decode (the body never runs)", () => {
	const out = decodeInput({});
	assert.isTrue(Exit.isFailure(out));
});

it("a wrong confirmation token fails input decode (the body never runs)", () => {
	const out = decodeInput({confirmation: "sil"});
	assert.isTrue(Exit.isFailure(out));
});

it("the input carries NO target field — the caller is always the target", () => {
	const fields = Object.keys((inputSchema as {fields: Record<string, unknown>}).fields);
	assert.deepStrictEqual(fields, ["confirmation"]);
});

it.effect(
	"account.delete on an anonymous request fails with the wire UNAUTHORIZED before any anonymize",
	() =>
		Effect.gen(function* () {
			const exit = yield* resolveWire(mutations["account.delete"], {
				input: {confirmation: ACCOUNT_DELETE_CONFIRMATION},
				select: ["deleted"],
			}).pipe(
				Effect.provideService(CurrentUser, {user: undefined}),
				Effect.provideService(Pasaport, failOnContactPasaport),
				Effect.exit,
			);
			assert.isTrue(Exit.isFailure(exit));
			if (Exit.isFailure(exit)) {
				const error = Cause.findErrorOption(exit.cause);
				assert.isTrue(error._tag === "Some");
				if (error._tag === "Some") {
					assert.strictEqual(error.value.code, "UNAUTHORIZED");
				}
			}
		}),
);

it.effect("setUsername rejects the reserved `silinen` handle with INVALID_FORMAT, no DB read", () =>
	Effect.gen(function* () {
		const pasaport = yield* Pasaport;
		const exit = yield* pasaport.setUsername({userId: "u1", value: "silinen"}).pipe(Effect.exit);
		assert.isTrue(Exit.isFailure(exit));
		if (Exit.isFailure(exit)) {
			const error = Cause.findErrorOption(exit.cause);
			assert.isTrue(error._tag === "Some");
			if (error._tag === "Some") {
				assert.strictEqual(error.value._tag, "pasaport/UsernameInvalidFormat");
			}
		}
	}).pipe(Effect.provide(pasaportLayer(throwingAccess))),
);

it.effect("setUsername reserved-handle check is case/whitespace-normalized (` SILINEN ` too)", () =>
	Effect.gen(function* () {
		const pasaport = yield* Pasaport;
		const exit = yield* pasaport.setUsername({userId: "u1", value: " SILINEN "}).pipe(Effect.exit);
		assert.isTrue(Exit.isFailure(exit));
		if (Exit.isFailure(exit)) {
			const error = Cause.findErrorOption(exit.cause);
			if (error._tag === "Some") {
				assert.strictEqual(error.value._tag, "pasaport/UsernameInvalidFormat");
			}
		}
	}).pipe(Effect.provide(pasaportLayer(throwingAccess))),
);
