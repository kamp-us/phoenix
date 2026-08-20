/**
 * `FirstContributionOnramp` — the çaylak-only nudge on a write surface (#1210).
 * The tier comes from the fate `me` view, never the untrusted better-auth session
 * field. It carries no CTA on purpose: the composer a button would "lead" to is
 * already rendered right below, so the button was a doubled affordance (#2208).
 */
import {useId} from "react";
import type {Tier} from "../../../worker/features/kunye/standing";
import {useMe} from "../../auth/useMe";
import "./FirstContributionOnramp.css";

export type OnrampSurface = "sozluk" | "pano" | "pano-comment";

/** Only a çaylak's first entry is sandboxed, so the honest-framing copy is truthful for a çaylak alone. */
export function shouldShowOnramp(tier: Tier | undefined): boolean {
	return tier === "çaylak";
}

// A total `Record`, not a ternary chain: a surface added to the union without its
// copy is a compile error, never another surface's noun rendered by accident.
const ONRAMP_HEADINGS: Record<OnrampSurface, string> = {
	sozluk: "ilk tanımını yazmaya hazırsın",
	pano: "ilk gönderini paylaşmaya hazırsın",
	"pano-comment": "ilk yorumunu yazmaya hazırsın",
};

export function onrampCopy(surface: OnrampSurface): {heading: string} {
	return {heading: ONRAMP_HEADINGS[surface]};
}

export interface FirstContributionOnrampProps {
	readonly surface: OnrampSurface;
}

export function FirstContributionOnramp({surface}: FirstContributionOnrampProps) {
	const {me} = useMe();
	const headingId = useId();

	if (!shouldShowOnramp(me?.tier)) return null;

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
		</section>
	);
}
