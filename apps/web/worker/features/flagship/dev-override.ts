/**
 * Dev-only flag-override store (#622) — the local-flip surface that lets a dev
 * exercise the flag-*on* path under offline `alchemy dev`, where the Flagship
 * binding doesn't resolve to a live evaluator and every read degrades to its
 * safe default.
 *
 * The store is a `phoenix_flag_overrides` cookie carrying a JSON map of
 * `{key: boolean}` — the dev settings page (`route-dev.ts`) sets it; the dev-only
 * override `Flags` wrapper (`FlagsDevOverrideLive`, `Flags.ts`) reads the map off
 * the per-request `FlagsContext` and short-circuits a `getBoolean` read whose key
 * is present, otherwise delegating to the real `Flags`.
 *
 * **HARD INVARIANT (load-bearing, the #622 review's primary check):** this whole
 * surface is unreachable in any deployed stage. The wrapper is only installed and
 * the route only mounts when `environment === "development"` (`http/app.ts` /
 * `route-dev.ts`), gated on the same `ENVIRONMENT` config that fail-closes to
 * `"production"` (`config.ts`). This module is a pure cookie codec — it carries no
 * gate of its own; the gate lives at the two install sites and is the thing to
 * verify. Even so, an override only ever forces a flag *on or off locally*; it
 * never reaches Flagship or another request's state.
 */

import {DEMO_TARGETING_FLAG_KEY} from "./resources.ts";

/** The cookie the dev override map travels in. Dev-only; never set in any deployed stage. */
export const FLAG_OVERRIDE_COOKIE = "phoenix_flag_overrides";

/** The per-request override map: a declared flag key forced to a local boolean value. */
export type FlagOverrides = Readonly<Record<string, boolean>>;

/** No overrides — the request carries no override cookie (or a malformed one). */
export const emptyOverrides: FlagOverrides = {};

/**
 * The boolean flags the dev settings page lists with on/off/clear toggles (#622).
 * The override surface is boolean-only (the dark-ship primitive), so the typed
 * `phoenix-flags-probe-variant`/percentage demos are out. A key here is just a flag
 * the dev wants to flip locally; an override key absent from this list still works
 * (the wrapper short-circuits any key), the list only seeds the UI.
 */
export const DEV_OVERRIDABLE_FLAGS: readonly string[] = [
	DEMO_TARGETING_FLAG_KEY,
	"phoenix-flags-probe",
];

/** A flag's tri-state on the dev page: forced on, forced off, or no local override. */
export type OverrideState = "on" | "off" | "clear";

/** The override action a dev settings POST carries: force a key on/off, or clear it. */
export interface OverrideAction {
	readonly key: string;
	readonly state: OverrideState;
}

/**
 * Apply one tri-state action to an override map: `on`/`off` set the key, `clear`
 * removes it. Pure — the new map is what `route-dev.ts` re-serializes into the
 * Set-Cookie value.
 */
export function applyOverride(
	overrides: FlagOverrides,
	{key, state}: OverrideAction,
): FlagOverrides {
	if (state === "clear") {
		const {[key]: _dropped, ...rest} = overrides;
		return rest;
	}
	return {...overrides, [key]: state === "on"};
}

/**
 * Parse a dev settings POST body (`application/x-www-form-urlencoded`: `key` +
 * `state`) into an {@link OverrideAction}, or `null` if malformed. The page POSTs a
 * single key/state pair per toggle; a bad body yields `null` and the route no-ops.
 */
export function parseOverrideAction(form: URLSearchParams): OverrideAction | null {
	const key = form.get("key");
	const state = form.get("state");
	if (key === null || key === "") return null;
	if (state !== "on" && state !== "off" && state !== "clear") return null;
	return {key, state};
}

/**
 * Parse the `phoenix_flag_overrides` value out of a raw `Cookie` header. Returns
 * `{}` for an absent header or absent cookie — the no-override case. Untrusted
 * input: anything that isn't a well-formed `{[key]: boolean}` JSON object yields
 * `{}`, so a malformed cookie degrades to "no override" (the real `Flags` answers)
 * rather than throwing.
 */
export function parseOverrideCookie(cookieHeader: string | null | undefined): FlagOverrides {
	if (!cookieHeader) return emptyOverrides;
	const raw = readCookieValue(cookieHeader, FLAG_OVERRIDE_COOKIE);
	if (raw === undefined) return emptyOverrides;
	return decodeOverrides(raw);
}

/** Pull one cookie's raw value out of a `name=value; name2=value2` header. */
function readCookieValue(cookieHeader: string, name: string): string | undefined {
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

/** Decode a URL-encoded JSON override map, keeping only boolean-valued entries. */
function decodeOverrides(raw: string): FlagOverrides {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeURIComponent(raw));
	} catch {
		return emptyOverrides;
	}
	if (typeof parsed !== "object" || parsed === null) return emptyOverrides;
	const out: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value === "boolean") out[key] = value;
	}
	return out;
}

/** Serialize an override map to the cookie's URL-encoded JSON value (no attributes). */
export function encodeOverrideCookieValue(overrides: FlagOverrides): string {
	return encodeURIComponent(JSON.stringify(overrides));
}
