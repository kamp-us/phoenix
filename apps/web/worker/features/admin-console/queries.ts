/**
 * The admin-console root query resolver (#2740, epic #2711) — `admin.probe`, the
 * console's single gated read: it resolves iff the caller may open the admin console, so
 * the SPA can decide whether to mount+fetch the lazy console bundle without shipping any
 * admin-ness to a non-admin.
 *
 * The gate is enforced HERE (there is no unconditional read path): the {@link requireAdmin}
 * capability gate — `Admin.over(platform)` only. `yield* Admin` makes the row unreachable
 * without the discharged grant, and its denial is the künye {@link Denied}
 * (`UNAUTHORIZED`), so a non-admin cannot distinguish "not an admin" from "not signed in"
 * (the invisible-denial invariant, ADR 0107 / ADR 0098 §2). The dark-ship flag that once
 * sat in front of it was retired at 100% rollout (#3671); this capability check was always
 * the authorization, the flag only a rollout gate on top.
 *
 * A synthetic singleton like `funnel.summary`: the wire type is the NAME string
 * (`"AdminProbe"`), not the view class, so the entity stays off the source-completeness
 * path (this resolver is its only producer, no by-id fetch to leak).
 */
import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Admin, requireAdmin} from "../kunye/admin.ts";
import {Denied} from "../kunye/errors.ts";

const ADMIN_PROBE_ID = "admin-probe";

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
			return yield* requireAdmin(probeGated());
		}),
	),
};
