/**
 * The admin-console root query resolver (#2740, epic #2711) — `admin.probe`, the
 * console's single gated read: it resolves iff the caller may open the admin console, so
 * the SPA can decide whether to mount+fetch the lazy console bundle without shipping any
 * admin-ness to a non-admin.
 *
 * Two gates, both enforced HERE (there is no unconditional read path):
 *
 *   1. The `phoenix-admin-console` dark-ship flag (default-off, ADR 0083). Off ⇒ the read
 *      fails the invisible {@link Denied}, exactly like a non-admin call — so with the flag
 *      off (default / Flagship outage) the console is inert for everyone, even on a direct
 *      call. Read with the safe `false` default (the `funnel.summary` idiom).
 *   2. The {@link requireAdmin} capability gate — `Admin.over(platform)` only. `yield* Admin`
 *      makes the row unreachable without the discharged grant, and its denial is the künye
 *      {@link Denied} (`UNAUTHORIZED`), so a non-admin cannot distinguish "not an admin" from
 *      "not signed in" (the invisible-denial invariant, ADR 0107 / ADR 0098 §2).
 *
 * A synthetic singleton like `funnel.summary`: the wire type is the NAME string
 * (`"AdminProbe"`), not the view class, so the entity stays off the source-completeness
 * path (this resolver is its only producer, no by-id fetch to leak).
 */
import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {PHOENIX_ADMIN_CONSOLE} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Admin, requireAdmin} from "../kunye/admin.ts";
import {Denied} from "../kunye/errors.ts";

const ADMIN_PROBE_ID = "admin-probe";

/** Is the admin console on for this request? Safe-default `false` (dark). */
const consoleOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(PHOENIX_ADMIN_CONSOLE, false).pipe(provideRequestFlags);
});

// The post-gate probe row — `Admin`-gated in R (`requireAdmin` provides the grant).
// `yield* Admin` requires the proof; the row is unreachable without a discharged grant.
const probeGated = Effect.fn("admin.probeGated")(function* () {
	yield* Admin;
	return {__typename: "AdminProbe" as const, id: ADMIN_PROBE_ID, admin: true};
});

export const queries = {
	"admin.probe": Fate.query(
		{type: "AdminProbe", error: Schema.Union([Denied])},
		Effect.fn("admin.probe")(function* () {
			if (!(yield* consoleOn)) {
				return yield* Effect.fail(new Denied({message: "Bu işlem şu an kapalı."}));
			}
			return yield* requireAdmin(probeGated());
		}),
	),
};
