/**
 * `Moderator.required` unit coverage (ADR 0098 §2) — the gate PASSes on a
 * scripted `role: "moderator"` and FAILs (`NotAModerator`) on a member, with the
 * role read from the `Pasaport` seam (scripted), no database. Also: anonymous →
 * `Unauthorized` (via `CurrentUser.required`). The whole point is that "moderated
 * without authority" is gated structurally — this proves the runtime side of it.
 */

import {assert, describe, it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {Effect, type Layer} from "effect";
import {makePasaportStub} from "../pasaport/Pasaport.testing.ts";
import type {Pasaport, UserRow} from "../pasaport/Pasaport.ts";
import {Moderator, NotAModerator} from "./Moderator.ts";

const userRow = (role: "member" | "moderator"): UserRow => ({
	id: "u1",
	email: "u1@test.local",
	name: "U One",
	image: null,
	username: "u-one",
	role,
});

// A Pasaport double whose `getUserById` returns the scripted row; every other
// method fails-on-contact via the shared stub (the gate must touch only `getUserById`).
const pasaportWithRole = (row: UserRow | null): Layer.Layer<Pasaport> =>
	makePasaportStub({getUserById: () => Effect.succeed(row)});

const sessionUser = {id: "u1", email: "u1@test.local", name: "U One"};

describe("Moderator.required", () => {
	it.effect("role=moderator → yields the ModeratorIdentity (PASS)", () =>
		Effect.gen(function* () {
			const mod = yield* Moderator.required;
			assert.strictEqual(mod.id, "u1");
			assert.strictEqual(mod.email, "u1@test.local");
		}).pipe(
			Effect.provideService(CurrentUser, {user: sessionUser}),
			Effect.provide(pasaportWithRole(userRow("moderator"))),
		),
	);

	it.effect("role=member → NotAModerator (FAIL)", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(Moderator.required);
			assert.isTrue(exit._tag === "Failure");
			const err = exit._tag === "Failure" ? exit.cause : null;
			assert.match(String(err), /NotAModerator/);
		}).pipe(
			Effect.provideService(CurrentUser, {user: sessionUser}),
			Effect.provide(pasaportWithRole(userRow("member"))),
		),
	);

	it.effect("unknown user (getUserById null) → NotAModerator (fail-closed)", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(Moderator.required);
			assert.isTrue(exit._tag === "Failure");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /NotAModerator/);
		}).pipe(
			Effect.provideService(CurrentUser, {user: sessionUser}),
			Effect.provide(pasaportWithRole(null)),
		),
	);

	it.effect("anonymous → Unauthorized", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(Moderator.required);
			assert.isTrue(exit._tag === "Failure");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /Unauthorized/);
		}).pipe(
			Effect.provideService(CurrentUser, {user: undefined}),
			Effect.provide(pasaportWithRole(userRow("moderator"))),
		),
	);

	it("NotAModerator is a tagged error (invisible UNAUTHORIZED wire code, ADR 0098 §2)", () => {
		const err = new NotAModerator({message: "x"});
		// Annotated UNAUTHORIZED so the wire can't distinguish a non-moderator from an
		// anonymous caller; the instance carries its `_tag`.
		assert.strictEqual(err._tag, "report/NotAModerator");
		assert.instanceOf(err, NotAModerator);
	});
});
