/**
 * `FirstContributionOnramp` — the çaylak-only nudge on a write surface (#1210,
 * epic #1202). Turns "I just joined" into "I wrote my first thing" with **honest
 * framing**: a freshly-registered çaylak's first entry lands in the mod-only
 * sandbox (#1205) pending promotion to yazar (#1206), so the copy says exactly
 * that — it never promises instant publication.
 *
 * Two gates, both required (see {@link shouldShowOnramp}): the
 * `phoenix-authorship-loop` flag (#1204, default-off via `useFlag(..., false)`)
 * AND the trusted account tier read off `useMe().me.tier` (#1297) being `çaylak`.
 * A yazar (whose entries aren't sandboxed), a visitor, or a flag-off render is a
 * clean no-op — exactly today's behavior. The tier is read from the fate `me`
 * view, never the untrusted better-auth session field.
 *
 * It does NOT touch the surface's draft autosave (#1214) — the on-ramp only
 * nudges + focuses the composer, so in-progress writing survives the auth
 * round-trip exactly as before.
 *
 * a11y: a labelled `<section>` region (`aria-labelledby` → its own heading), a
 * real `<h2>` (not div-soup), an optional native `<Button>` (full keyboard path +
 * visible focus + AA contrast from the shared button styles); meaning is carried
 * by text, never color alone; copy is lowercase Turkish (çaylak/yazar/karma are
 * brand nouns); no animation — reduced-motion-safe by default, and the global
 * `prefers-reduced-motion` reset (styles/global.css) neutralizes any inherited
 * transition.
 */
import {useId} from "react";
import type {Tier} from "../../../worker/features/kunye/standing";
import {useMe} from "../../auth/useMe";
import {PHOENIX_AUTHORSHIP_LOOP} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";
import {Button} from "../ui/Button";
import "./FirstContributionOnramp.css";

/** The write surface the on-ramp sits on — selects the per-surface copy noun. */
export type OnrampSurface = "sozluk" | "pano";

/**
 * The on-ramp's gating decision, factored DOM-free so the contract — show iff the
 * authorship flag is on AND the viewer is a çaylak — is unit-testable without a
 * DOM (the pure-extraction idiom of `flagGateChild`). Only a çaylak's first entry
 * is sandboxed, so the honest-framing copy is truthful for a çaylak alone; a
 * yazar/visitor or a flag-off read is `false`. A gate that dropped either half
 * (showed for a yazar, or ignored the flag) would fail exactly this function.
 */
export function shouldShowOnramp(flagOn: boolean, tier: Tier | undefined): boolean {
	return flagOn && tier === "çaylak";
}

/** Per-surface lowercase-Turkish heading + CTA label. The body copy is shared. */
export function onrampCopy(surface: OnrampSurface): {heading: string; cta: string} {
	return surface === "sozluk"
		? {heading: "ilk tanımını yazmaya hazırsın", cta: "ilk tanımını yaz"}
		: {heading: "ilk gönderini paylaşmaya hazırsın", cta: "ilk gönderini yaz"};
}

export interface FirstContributionOnrampProps {
	/** The write surface — picks the copy noun. */
	readonly surface: OnrampSurface;
	/**
	 * Optional "start writing" handler — the page wires it to focus its composer
	 * field, so the CTA actually guides to the first contribution. Omitted ⇒ no
	 * CTA button (the honest framing still renders).
	 */
	readonly onStart?: () => void;
}

export function FirstContributionOnramp({surface, onStart}: FirstContributionOnrampProps) {
	// Default `false`: the on-ramp stays dark until the server evaluates the flag on
	// AND the viewer is a çaylak — every flag failure mode (loading/error/undeclared)
	// resolves to `false`, so the gate degrades to today's behavior.
	const {value: flagOn} = useFlag(PHOENIX_AUTHORSHIP_LOOP, false);
	const {me} = useMe();
	const headingId = useId();

	if (!shouldShowOnramp(flagOn, me?.tier)) return null;

	const copy = onrampCopy(surface);
	return (
		<section
			className="kp-onramp"
			aria-labelledby={headingId}
			data-testid="first-contribution-onramp"
		>
			<h2 id={headingId} className="kp-onramp__heading">
				{copy.heading}
			</h2>
			<p className="kp-onramp__body">
				çaylak olarak yazdıkların, sen yazar olana kadar yalnızca moderatörlerin gördüğü bir alanda
				incelenir — hemen herkese görünmez. yazıp katkı verdikçe karma toplar, bir yazarın
				desteğiyle yazar olursun; o zaman yazdıkların doğrudan yayına girer.
			</p>
			{onStart ? (
				<div className="kp-onramp__actions">
					<Button
						type="button"
						variant="secondary"
						size="sm"
						onClick={onStart}
						data-testid="first-contribution-onramp-start"
					>
						{copy.cta}
					</Button>
				</div>
			) : null}
		</section>
	);
}
