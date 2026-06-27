/**
 * The pure promotion-bar rule (#1316) — `promotionBarFor` decides WHICH karma bar a
 * çaylak faces from a single fact: do they hold an active vouch. Kept pure (no
 * service, no Effect) so the "which bar applies" rule the çaylak-self standing read
 * exposes is testable in isolation (ADR 0082 unit tier) — the frontend never
 * hardcodes a bar because the live bar depends on vouch-exists.
 */
import {describe, it} from "@effect/vitest";
import {assert} from "vitest";
import {KARMA_THRESHOLDS, promotionBarFor, VOUCH_PROMOTION_KARMA_BAR} from "./standing.ts";

describe("promotionBarFor", () => {
	it("a vouched çaylak clears the reduced tandem bar", () => {
		assert.strictEqual(promotionBarFor(true), VOUCH_PROMOTION_KARMA_BAR);
	});

	it("an unvouched çaylak faces the full unassisted yazar threshold", () => {
		assert.strictEqual(promotionBarFor(false), KARMA_THRESHOLDS.yazar);
	});

	it("the vouch-assisted bar is strictly lower than the unassisted one", () => {
		assert.isBelow(promotionBarFor(true), promotionBarFor(false));
	});
});
