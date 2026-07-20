/**
 * `overridesAuthorized` — may THIS request honor its per-browser
 * `phoenix_flag_overrides` cookie (#622)? The per-request gate that un-gates the
 * local-override read-wrapper to production for an admin (#2741, epic #2711),
 * replacing #622's isolate-wide `environment === "development"` install gate.
 *
 * `true` iff either:
 *   - `environment === "development"` — the #622 local-dev convenience, unchanged; OR
 *   - the request actor holds platform {@link Admin} authority.
 *
 * Fail-safe by construction: a non-admin (the invisible `Denied` from `Admin.over`) and
 * an anonymous request both resolve `false`, so `makeRequestFlagsContext` drops the cookie
 * and the override wrapper no-ops — byte-identical to a plain `FlagsLive` read. The
 * verdict is derived ONLY from the environment and the actor's stored platform-admin
 * relation, never from anything the request carries, so an attacker-supplied cookie can
 * never self-authorize the gate (the load-bearing #622 / `FlagsContext.ts` invariant).
 * The admin-console dark-ship flag that once ANDed into the admin arm was retired at 100%
 * rollout (#3671) — it was a rollout gate on top of the admin check, never the
 * authorization itself.
 */
import {Effect} from "effect";
import {Admin, platform} from "../kunye/admin.ts";
import type {FlagsContextValue} from "./FlagsContext.ts";

export const overridesAuthorized = (baseline: FlagsContextValue) =>
	Effect.gen(function* () {
		if (baseline.environment === "development") return true;
		return yield* Admin.over(platform).pipe(
			Effect.match({onFailure: () => false, onSuccess: () => true}),
		);
	});
