/**
 * `admin.probe` — resolves iff the caller may open the admin console, so the SPA can
 * decide whether to mount the lazy console bundle without shipping any admin-ness to a
 * non-admin. Its denial is the invisible `Denied`, so a non-admin cannot tell "not an
 * admin" from "not signed in" (ADR 0107).
 *
 * The wire type is the NAME string, not the view class, which keeps the entity off the
 * source-completeness path — this resolver is its only producer, so there is no by-id
 * fetch to leak.
 */
import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Admin, requireAdmin} from "../kunye/admin.ts";
import {Denied} from "../kunye/errors.ts";

const ADMIN_PROBE_ID = "admin-probe";

// `yield* Admin` demands the proof in R, so the row is unreachable without a discharged
// grant — a compile-time gate, not an `if`.
const probeGated = Effect.fn("admin.probeGated")(function* () {
	yield* Admin;
	return {__typename: "AdminProbe" as const, id: ADMIN_PROBE_ID, admin: true};
});

export const queries = {
	"admin.probe": Fate.query(
		{type: "AdminProbe", error: Schema.Union([Denied])},
		Effect.fn("admin.probe")(function* () {
			return yield* requireAdmin(probeGated());
		}),
	),
};
