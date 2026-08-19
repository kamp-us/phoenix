/**
 * The landing page's join-CTA gating, kept DOM-free so it is unit-testable
 * (`apps/web/src` has no jsdom).
 *
 * The phase is three-valued rather than a `signedIn` boolean because auth resolves in two
 * async steps (`useSession`, then `useMe`): a boolean reads anonymous mid-resolve and
 * flashes the CTA on and then off (#448). It reads `useMe` — the same signal the topbar
 * reads — so the two can never disagree about auth state (#1784).
 */
import type {MeStatus} from "../auth/useMe";

export type LandingCtaPhase = "anonymous" | "signedIn" | "resolving";

export function landingCtaPhase(sessionPending: boolean, meStatus: MeStatus): LandingCtaPhase {
	if (sessionPending) return "resolving";
	if (meStatus === "idle") return "anonymous";
	if (meStatus === "ok") return "signedIn";
	// `error` lands here on purpose, not in `anonymous`: a failed row read for an
	// established session must not flash a join prompt at a signed-in user.
	return "resolving";
}

export function showJoinCta(phase: LandingCtaPhase): boolean {
	return phase === "anonymous";
}
