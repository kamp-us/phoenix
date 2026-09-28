// The chip's derivation is pure, so the honesty rule and the delta copy are asserted as
// values — `apps/web/src` has no jsdom. The rendered half lives in `Topbar.test.tsx`.
import {describe, expect, it} from "vitest";
import {promotionBarFor, VOUCH_PROMOTION_KARMA_BAR} from "../../../worker/features/kunye/standing";
import {trCatalog} from "../../i18n";
import {caylakMeter} from "./caylakMeter";

// Fixtures built from `promotionBarFor`, not from literals: `bar` is whatever the wire's own
// producer sends for that vouch state, so an unvouched case can never drift back to a standing
// the backend cannot emit (`{bar: 15, vouchExists: false}`).
const unvouched = (karma: number) => ({karma, bar: promotionBarFor(false), vouchExists: false});

describe("caylakMeter — the next unmet condition, with its delta", () => {
	it("inherits the #1323 honesty rule: no karma-bar variant is reachable while unvouched", () => {
		for (const karma of [-3, 0, 9, 15, 99]) {
			expect(caylakMeter(unvouched(karma)).kind).toBe("vouch-needed");
		}
	});

	// The wire sends the unassisted 100 while unvouched, and that is the goal #1323 calls
	// unlivable. Naming it in the chip would move the dishonesty out of the bar and into a
	// string, so the delta reads against the reduced bar the kefil buys down to.
	it("names the reduced bar for an unvouched çaylak, never the 100 the wire sends", () => {
		const standing = unvouched(9);
		expect(standing.bar).toBe(100);
		const meter = caylakMeter(standing);
		expect(meter.target).toBe(VOUCH_PROMOTION_KARMA_BAR);
		expect(`karma ${meter.karma}/${meter.target} · ${trCatalog[meter.vouchFactKey]}`).toBe(
			"karma 9/15 · kefil: yok",
		);
	});

	it("reports a vouched delta against the bar it was handed, never a re-derived target", () => {
		const meter = caylakMeter({karma: 40, bar: 100, vouchExists: true});
		expect(`karma ${meter.karma}/${meter.target} · ${trCatalog[meter.vouchFactKey]}`).toBe(
			"karma 40/100 · kefil: var",
		);
	});
});
