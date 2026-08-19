/**
 * What `/caylak-gorunurlugu` renders, as a pure function of the four signals the page
 * reads (#6426, epic #4306). Extracted DOM-free — the `landingGating` / `mecmua-write-gate`
 * idiom — so the order of the gates is pinned without a render.
 *
 * The order is load-bearing. `loading` outranks everything so the 404 never flashes before
 * the flag resolves; `not-found` outranks the session so a dark feature leaks nothing to a
 * signed-out visitor either; and an unread tier is `loading`, never `caylak` — telling a
 * yazar they are a çaylak because their `me` read had not landed yet would be a lie.
 */
import type {Tier} from "../../worker/features/kunye/standing";

export type CaylakVisibilityGate =
	/** The flag, the session or the tier is still resolving — a neutral placeholder. */
	| "loading"
	/** The flag is off: the route does not exist. */
	| "not-found"
	/** Signed out: send them to auth carrying a `returnTo`. */
	| "sign-in"
	/** The tier read failed, so neither the toggle nor the çaylak line would be honest. */
	| "unavailable"
	/** A signed-in çaylak: the plain explanation, no control. */
	| "caylak"
	/** A signed-in yazar: the toggle. */
	| "toggle";

export interface CaylakVisibilityGateInput {
	readonly flagOn: boolean;
	readonly flagLoading: boolean;
	readonly sessionPending: boolean;
	readonly signedIn: boolean;
	/** The trusted account tier; `null`/`undefined` while the `me` read is still in flight. */
	readonly tier: Tier | null | undefined;
	/** The `me` read errored — the tier is unknown and will not arrive. */
	readonly meFailed: boolean;
}

export function caylakVisibilityGate(input: CaylakVisibilityGateInput): CaylakVisibilityGate {
	if (input.flagLoading || input.sessionPending) return "loading";
	if (!input.flagOn) return "not-found";
	if (!input.signedIn) return "sign-in";
	if (input.meFailed) return "unavailable";
	if (input.tier == null) return "loading";
	return input.tier === "yazar" ? "toggle" : "caylak";
}
