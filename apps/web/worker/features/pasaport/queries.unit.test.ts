/**
 * Unit coverage for the pasaport `me` resolver's auth gate — the anonymous →
 * `UNAUTHORIZED` boundary, proven with NO database (ADR 0082). The litmus: the
 * gate is wrong-or-right independent of the DB — `CurrentUser.required` fails
 * with `Unauthorized` (wire `UNAUTHORIZED`) before any `Pasaport` read — so it
 * belongs at `unit`, not on a faked SQL engine.
 *
 * Re-homed from the deleted `node:sqlite` fate-op suite
 * (`features/fate/sozluk.test.ts`), whose "me anonymous → UNAUTHORIZED" case
 * booted the full interpreter over a faked engine only to assert this pure gate.
 * Here the `me` handler runs directly over an anonymous `CurrentUser` and a
 * fail-on-contact `Pasaport` sentinel: the sentinel proves the gate
 * short-circuits the DB read (a reached read would `die`, not `Unauthorized`).
 */

import {it} from "@effect/vitest";
import {CurrentUser, Unauthorized} from "@kampus/fate-effect";
import {Cause, Effect, Exit} from "effect";
import {assert} from "vitest";
import {Pasaport} from "./Pasaport.ts";
import {queries} from "./queries.ts";

// Fail-on-contact `Pasaport`: any method call dies, so a passing test proves the
// gate never reached the DB (a reached read would `die`, not `Unauthorized`).
// `as never` widens the partial stub to the full service shape — the anon path
// touches none of these methods.
const failOnContactPasaport = {
	getUserById: () => Effect.die("Pasaport.getUserById must not be reached on the anon gate"),
} as never;

it.effect("me on an anonymous request fails with Unauthorized before any Pasaport read", () =>
	Effect.gen(function* () {
		const exit = yield* queries.me
			.handler({args: undefined, select: ["id"]})
			.pipe(
				Effect.provideService(CurrentUser, {user: undefined}),
				Effect.provideService(Pasaport, failOnContactPasaport),
				Effect.exit,
			);
		// A typed `Unauthorized` failure (wire `UNAUTHORIZED`) — not a defect from a
		// reached DB read, which the fail-on-contact `Pasaport` would have surfaced.
		assert.isTrue(Exit.isFailure(exit));
		if (Exit.isFailure(exit)) {
			const error = Cause.findErrorOption(exit.cause);
			assert.isTrue(error._tag === "Some");
			if (error._tag === "Some") {
				assert.instanceOf(error.value, Unauthorized);
			}
		}
	}),
);
