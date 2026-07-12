/**
 * `overridesAuthorized` — may THIS request honor its per-browser
 * `phoenix_flag_overrides` cookie (#622)? The per-request gate that un-gates the
 * local-override read-wrapper to production for an admin (#2741, epic #2711),
 * replacing #622's isolate-wide `environment === "development"` install gate.
 *
 * `true` iff either:
 *   - `environment === "development"` — the #622 local-dev convenience, unchanged; OR
 *   - the request actor holds platform {@link Admin} authority AND the
 *     `phoenix-admin-console` dark-ship flag is ON (default-off, ADR 0083).
 *
 * Fail-safe by construction: a non-admin (the invisible `Denied` from
 * `Admin.over`), an anonymous request, a flag-off / Flagship-outage read all
 * resolve `false`, so `makeRequestFlagsContext` drops the cookie and the override
 * wrapper no-ops — byte-identical to a plain `FlagsLive` read. The gate flag is read
 * against the caller's BASELINE (no-override) context, so an attacker-supplied
 * cookie can never self-authorize the gate (the load-bearing #622 /
 * `FlagsContext.ts` invariant, now honored on prod only for an admin).
 */
import {Effect} from "effect";
import {PHOENIX_ADMIN_CONSOLE} from "../../../src/flags/keys.ts";
import {Admin, platform} from "../kunye/admin.ts";
import {Flags} from "./Flags.ts";
import {FlagsContext, type FlagsContextValue} from "./FlagsContext.ts";

export const overridesAuthorized = (baseline: FlagsContextValue) =>
	Effect.gen(function* () {
		if (baseline.environment === "development") return true;
		// Read the dark-ship gate against the baseline context (no overrides) — so the
		// cookie cannot flip the flag that decides whether the cookie is honored — then,
		// only if the console is on, discharge platform-admin authority. Ordered flag-then-
		// admin so a flag-off request skips the `RelationStore` (D1) admin read entirely.
		const flags = yield* Flags;
		const consoleOn = yield* flags
			.getBoolean(PHOENIX_ADMIN_CONSOLE, false)
			.pipe(Effect.provideService(FlagsContext, baseline));
		if (!consoleOn) return false;
		return yield* Admin.over(platform).pipe(
			Effect.match({onFailure: () => false, onSuccess: () => true}),
		);
	});
