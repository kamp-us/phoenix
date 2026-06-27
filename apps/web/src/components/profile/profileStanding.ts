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
 * Two load-bearing invariants the test pins:
 *   - **No false label, ever.** When there is no honest tier to show — the tier is
 *     still loading/errored (`undefined`), or it is the read-time `visitor` rank an
 *     authenticated account never legitimately holds — the function returns `null`,
 *     and the header renders handle-only. It never substitutes a new placeholder
 *     that lies (the exact bug #1302 fixes).
 *   - **Flag-gated, dark by default.** The earned-authorship tier vocabulary ships
 *     dark behind `phoenix-authorship-loop` (ADR 0083), the same seam every other
 *     authorship surface gates on (Karma stat, CaylakStatusBlock #1291,
 *     FirstContributionOnramp). With the flag off the label is `null` → handle-only,
 *     so the tier surfaces here exactly when the rest of the loop does, never
 *     contradicting the dark CaylakStatusBlock.
 *
 * Copy is the lowercase-Turkish glossary rank (`çaylak` / `yazar`,
 * `.glossary/TERMS.md`), never an invented label.
 */
import type {Tier} from "../../../worker/features/kunye/standing";

export function profileStandingLabel(flagOn: boolean, tier: Tier | undefined): string | null {
	if (!flagOn) return null;
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
