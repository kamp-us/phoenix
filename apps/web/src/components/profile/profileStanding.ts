/**
 * The profile-header standing label (#1302) — replaces the hard-coded `· yeni üye`
 * subtitle that asserted "new member" for EVERY account regardless of standing.
 *
 * Derived from the trusted account tier (`useMe().me.tier`, exposed on the fate
 * read path by #1297), so the label is true: a yazar reads `yazar`, a çaylak reads
 * `çaylak`, never a static placeholder. Factored DOM-free (the pure-extraction
 * idiom of `shouldShowOnramp` / `shouldShowCaylakStatus`) so the per-tier mapping
 * is unit-testable without a DOM (`apps/web/src` has no jsdom).
 *
 * **No false label, ever.** When there is no honest tier to show — the tier is
 * still loading/errored (`undefined`), or it is the read-time `visitor` rank an
 * authenticated account never legitimately holds — the function returns `null`, and
 * the header renders handle-only. It never substitutes a new placeholder that lies
 * (the exact bug #1302 fixes).
 *
 * Copy is the lowercase-Turkish glossary rank (`çaylak` / `yazar`,
 * `.glossary/TERMS.md`), never an invented label.
 */
import type {Tier} from "../../../worker/features/kunye/standing";

export function profileStandingLabel(tier: Tier | undefined): string | null {
	switch (tier) {
		case "yazar":
			return "yazar";
		case "çaylak":
			return "çaylak";
		default:
			// `visitor` (never stored for an account) or an unknown/loading tier — no
			// honest label to show, so render handle-only rather than asserting one.
			return null;
	}
}
