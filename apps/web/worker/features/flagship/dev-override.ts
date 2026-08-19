/**
 * Dev-only flag-override store (#622) — a `phoenix_flag_overrides` cookie carrying
 * a JSON `{key: boolean}` map, so a dev can exercise the flag-*on* path under
 * offline `alchemy dev` where every read degrades to its safe default.
 *
 * **HARD INVARIANT:** this whole surface must stay unreachable in any deployed
 * stage. This module is a pure cookie codec and carries NO gate of its own — the
 * gate lives at the two install sites (`http/app.ts` / `route-dev.ts`, both on
 * `environment === "development"`), which is the thing to verify.
 */

import {DEMO_TARGETING_FLAG_KEY} from "./resources.ts";

export const FLAG_OVERRIDE_COOKIE = "phoenix_flag_overrides";

export type FlagOverrides = Readonly<Record<string, boolean>>;

export const emptyOverrides: FlagOverrides = {};

/**
 * Seeds the dev settings page's toggles only — the wrapper short-circuits ANY key,
 * so an override key absent from this list still works. Boolean-only, so the typed
 * variant/percentage demo flags are out.
 */
export const DEV_OVERRIDABLE_FLAGS: readonly string[] = [
	DEMO_TARGETING_FLAG_KEY,
	"phoenix-flags-probe",
];

export type OverrideState = "on" | "off" | "clear";

export interface OverrideAction {
	readonly key: string;
	readonly state: OverrideState;
}

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

/** `null` on a malformed body, which the route treats as a no-op. */
export function parseOverrideAction(form: URLSearchParams): OverrideAction | null {
	const key = form.get("key");
	const state = form.get("state");
	if (key === null || key === "") return null;
	if (state !== "on" && state !== "off" && state !== "clear") return null;
	return {key, state};
}

/**
 * Untrusted input: anything that isn't a well-formed `{[key]: boolean}` JSON object
 * yields `{}`, so a malformed cookie degrades to "no override" rather than throwing.
 */
export function parseOverrideCookie(cookieHeader: string | null | undefined): FlagOverrides {
	if (!cookieHeader) return emptyOverrides;
	const raw = readCookieValue(cookieHeader, FLAG_OVERRIDE_COOKIE);
	if (raw === undefined) return emptyOverrides;
	return decodeOverrides(raw);
}

function readCookieValue(cookieHeader: string, name: string): string | undefined {
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return undefined;
}

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

export function encodeOverrideCookieValue(overrides: FlagOverrides): string {
	return encodeURIComponent(JSON.stringify(overrides));
}
