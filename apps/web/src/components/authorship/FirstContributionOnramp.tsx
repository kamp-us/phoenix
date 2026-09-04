/**
 * `FirstContributionOnramp` — the çaylak-only nudge on a write surface (#1210).
 * The tier comes from the fate `me` view, never the untrusted better-auth session
 * field. It carries no CTA on purpose: the composer a button would "lead" to is
 * already rendered right below, so the button was a doubled affordance (#2208).
 */
import {useId} from "react";
import type {Tier} from "../../../worker/features/kunye/standing";
import {useMe} from "../../auth/useMe";
import {type CatalogKey, useT} from "../../i18n";
import "./FirstContributionOnramp.css";

export type OnrampSurface = "sozluk" | "pano" | "pano-comment";

/** Only a çaylak's first entry is sandboxed, so the honest-framing copy is truthful for a çaylak alone. */
export function shouldShowOnramp(tier: Tier | undefined): boolean {
	return tier === "çaylak";
}

// A total `Record`, not a ternary chain: a surface added to the union without its
// copy is a compile error, never another surface's noun rendered by accident.
const ONRAMP_HEADINGS: Record<OnrampSurface, CatalogKey> = {
	sozluk: "auth.onramp.heading.sozluk",
	pano: "auth.onramp.heading.pano",
	"pano-comment": "auth.onramp.heading.panoComment",
};

export function onrampHeadingKey(surface: OnrampSurface): CatalogKey {
	return ONRAMP_HEADINGS[surface];
}

export interface FirstContributionOnrampProps {
	readonly surface: OnrampSurface;
}

export function FirstContributionOnramp({surface}: FirstContributionOnrampProps) {
	const {me} = useMe();
	const headingId = useId();
	const t = useT();

	if (!shouldShowOnramp(me?.tier)) return null;

	return (
		<section
			className="kp-onramp"
			aria-labelledby={headingId}
			data-testid="first-contribution-onramp"
		>
			<h2 id={headingId} className="kp-onramp__heading">
				{t(onrampHeadingKey(surface))}
			</h2>
			<p className="kp-onramp__body">{t("auth.onramp.body")}</p>
		</section>
	);
}
