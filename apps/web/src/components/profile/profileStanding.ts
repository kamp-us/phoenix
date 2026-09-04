/**
 * The profile-header standing label. No false label, ever: with no honest tier to
 * show this returns `null` and the header renders handle-only, rather than the
 * hard-coded `yeni üye` placeholder it replaces, which lied for every account
 * (#1302).
 */
import type {Tier} from "../../../worker/features/kunye/standing";
import type {CatalogKey} from "../../i18n/keys";

export function profileStandingLabelKey(tier: Tier | undefined): CatalogKey | null {
	switch (tier) {
		case "yazar":
			return "profile.standing.yazar";
		case "çaylak":
			return "profile.standing.caylak";
		default:
			// `visitor` (never stored for an account) or an unknown/loading tier — no
			// honest label to show, so render handle-only rather than asserting one.
			return null;
	}
}
