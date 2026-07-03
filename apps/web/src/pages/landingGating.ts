/**
 * The landing page's auth-gating decision, factored DOM-free so the rule is
 * unit-testable without a DOM/React runtime — the pure-extraction idiom of
 * `divanGating` / `shouldShowOnramp` (`apps/web/src` has no jsdom).
 *
 * The defect (#1784): `LandingPage` rendered the `hesap aç →` join CTA and the
 * `kapı açık` rite framing unconditionally, so a signed-in user was still shown a
 * "create an account" call-to-action. The fix gates that framing on the SAME auth
 * signal the topbar reads — `useMe` (`../auth/useMe`) over `useSession`
 * (`../auth/client`) — so the landing and the topbar can never disagree about auth
 * state.
 *
 * The flash guard (#448): `useSession` resolves async (`{data:null,
 * isPending:true}` → user), and `useMe` carries its own `idle | loading | ok |
 * error` status. Collapsing those into a bare `signedIn` boolean would flash the
 * CTA on during the load transition (anonymous-looking mid-resolve) and then off.
 * So the decision is a THREE-valued phase — while auth is still resolving we render
 * the neutral state (neither CTA nor a signed-in variant), never a wrong-state CTA.
 */
import type {MeStatus} from "../auth/useMe";

/**
 * The landing CTA's auth phase:
 *  - `anonymous` — session resolved with no user: show the join CTA + rite framing.
 *  - `signedIn`  — session resolved to a user AND `me` loaded: hide the join CTA.
 *  - `resolving` — auth still settling (session pending, or signed in but `me` not
 *    yet loaded): render neither, so nothing flashes in/out during the transition.
 */
export type LandingCtaPhase = "anonymous" | "signedIn" | "resolving";

/**
 * Derive the CTA phase from the two topbar-shared signals: whether `useSession` is
 * still pending, and `useMe().status`. Mirrors the topbar's reading — a session is
 * "signed in" once established, and `me` (`ok`) carries the loaded row — collapsed
 * into the three-valued phase the landing surface renders on.
 *
 *  - `sessionPending` ⇒ `resolving` (auth unresolved; #448 — don't flash).
 *  - not pending, no session (`meStatus === "idle"`) ⇒ `anonymous`.
 *  - session present, `me` loaded (`meStatus === "ok"`) ⇒ `signedIn`.
 *  - session present, `me` still `loading` (first read / a session-update refetch)
 *    ⇒ `resolving`, so a mid-load refetch never flashes the CTA back in.
 *  - a `me` read `error` for an established session ⇒ `resolving` (treated as
 *    not-yet-authenticated for the CTA rather than flashing the join prompt at a
 *    signed-in user whose row read merely failed).
 */
export function landingCtaPhase(sessionPending: boolean, meStatus: MeStatus): LandingCtaPhase {
	if (sessionPending) return "resolving";
	if (meStatus === "idle") return "anonymous";
	if (meStatus === "ok") return "signedIn";
	// `loading` (first read or a session-update refetch) and `error` for an
	// established session are both unresolved for the CTA — render neither.
	return "resolving";
}

/** Show the `hesap aç →` join CTA + `kapı açık` rite framing iff the viewer is anonymous. */
export function showJoinCta(phase: LandingCtaPhase): boolean {
	return phase === "anonymous";
}
