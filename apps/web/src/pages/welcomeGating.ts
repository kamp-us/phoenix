/**
 * The welcome arrival's two pure decisions (#7043, epic #4304), extracted DOM-free —
 * the `landingGating` / `caylakVisibilityGating` idiom.
 *
 * `postAuthDestination` is what the post-auth redirect effect in `App.tsx` consults. The
 * flag-off branch is byte-for-byte today's behavior: the same target string out that went
 * in (already through `safeReturnTo`), so with the flag at its default the redirect is
 * unchanged no matter how the marker reads.
 */
import type {Tier} from "../../worker/features/kunye/standing";
import {safeReturnTo} from "../lib/returnTo";

export const WELCOME_PATH = "/hosgeldin";

export type PostAuthDestination =
	| {readonly kind: "context"; readonly to: string}
	| {readonly kind: "welcome"; readonly to: string};

export function postAuthDestination(
	welcomeOn: boolean,
	welcomeSeen: boolean,
	target: string,
): PostAuthDestination {
	if (!welcomeOn || welcomeSeen) return {kind: "context", to: target};
	return {kind: "welcome", to: `${WELCOME_PATH}?returnTo=${encodeURIComponent(target)}`};
}

/** The `returnTo` the arrival must hand back to — read off the welcome URL, guarded. */
export function welcomeReturnTo(search: string): string {
	return safeReturnTo(new URLSearchParams(search).get("returnTo"));
}

export type WelcomeGate =
	/** The flag or the session is still resolving — a neutral placeholder. */
	| "loading"
	/** The flag is off: the route does not exist. */
	| "not-found"
	/** Signed out: send them to auth carrying a `returnTo`. */
	| "sign-in"
	/** Already welcomed: suppress the surface, straight to the `returnTo`. */
	| "return"
	/** A signed-in account that has never been welcomed. */
	| "ready";

export interface WelcomeGateInput {
	readonly flagOn: boolean;
	readonly flagLoading: boolean;
	readonly sessionPending: boolean;
	readonly signedIn: boolean;
	readonly welcomeSeen: boolean;
}

/**
 * The order is load-bearing (`flag-dark-page-gate.md`): `loading` outranks everything so a
 * resolving flag never flashes the 404; a dark route leaks nothing to anyone; and the
 * seen-check comes after sign-in because an anonymous visitor has no account to have been
 * welcomed under.
 */
export function welcomeGate(input: WelcomeGateInput): WelcomeGate {
	if (input.flagLoading || input.sessionPending) return "loading";
	if (!input.flagOn) return "not-found";
	if (!input.signedIn) return "sign-in";
	if (input.welcomeSeen) return "return";
	return "ready";
}

/**
 * How the screen may address the reader. Only the two real tiers get standing claims;
 * anything else stays neutral, because addressing an unknown-tier reader as a çaylak
 * would be a lie (#4261).
 */
export function welcomeAddressing(tier: Tier | null | undefined): Tier | "unknown" {
	return tier === "çaylak" || tier === "yazar" ? tier : "unknown";
}
