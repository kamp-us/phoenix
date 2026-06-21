/**
 * Unit coverage for the pasaport `me` resolver's auth gate — the anonymous →
 * `UNAUTHORIZED` boundary, proven with NO database (ADR 0082). The litmus: the
 * gate is wrong-or-right independent of the DB — `CurrentUser.required` fails
 * before any `Pasaport` read — so it belongs at `unit`, not on a faked SQL engine.
 *
 * Re-homed from the deleted `node:sqlite` fate-op suite
 * (`features/fate/sozluk.test.ts`), whose "me anonymous → UNAUTHORIZED" case
 * booted the full interpreter over a faked engine only to assert this pure gate.
 * The `me` op runs through `resolveWire` — its real external interface (`resolve`
 * decode + the `encodeWireError` class→wire-code seam) — over an anonymous
 * `CurrentUser` and a fail-on-contact `Pasaport` sentinel: the sentinel proves the
 * gate short-circuits the DB read (a reached read would `die` → `INTERNAL_SERVER_ERROR`,
 * not `UNAUTHORIZED`). Asserting the WIRE `code` (not the typed `Unauthorized`
 * instance one layer in) is what makes a mis-annotated `[FateWireCode]` a unit failure.
 */

import {it} from "@effect/vitest";
import {CurrentUser} from "@kampus/fate-effect";
import {Cause, Effect, Exit} from "effect";
import {assert} from "vitest";
import {resolveWire} from "../fate/resolve-wire.testing.ts";
import {Pasaport} from "./Pasaport.ts";
import {queries} from "./queries.ts";

// Fail-on-contact `Pasaport`: any method call dies, so a passing test proves the
// gate never reached the DB (a reached read would `die`, not `Unauthorized`).
// `as never` widens the partial stub to the full service shape — the anon path
// touches none of these methods.
const failOnContactPasaport = {
	getUserById: () => Effect.die("Pasaport.getUserById must not be reached on the anon gate"),
} as never;

it.effect(
	"me on an anonymous request fails with the wire UNAUTHORIZED before any Pasaport read",
	() =>
		Effect.gen(function* () {
			const exit = yield* resolveWire(queries.me, {args: undefined, select: ["id"]}).pipe(
				Effect.provideService(CurrentUser, {user: undefined}),
				Effect.provideService(Pasaport, failOnContactPasaport),
				Effect.exit,
			);
			// The wire `UNAUTHORIZED` a client sees — derived by `encodeWireError` from the
			// `Unauthorized` class's `[FateWireCode]` annotation, not the typed instance one
			// layer in. A defect from a reached DB read would be `INTERNAL_SERVER_ERROR`.
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
