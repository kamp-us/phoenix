/**
 * `overridesAuthorized` — may THIS request honor its per-browser `phoenix_flag_overrides`
 * cookie? `true` iff `environment === "development"` or the request actor holds platform
 * {@link Admin} authority.
 *
 * Fail-safe by construction: a non-admin and an anonymous request both resolve `false`, so
 * the cookie is dropped and the override wrapper no-ops. The verdict is derived ONLY from
 * the environment and the actor's stored platform-admin relation, never from anything the
 * request carries, so an attacker-supplied cookie can never self-authorize the gate.
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
