/**
 * Pins the Tooltip popup stacking fix (#2046, mirror of the Menu fix in #2041/#2044):
 * the z-index that lifts a tooltip above the sticky `.kp-subnav` row must sit on the
 * *Positioner* — the positioned (`position: absolute`) portal-root element — not on the
 * inner `.kp-tooltip__popup`, which is `position: static` and so ignores z-index entirely.
 * Putting it on the static popup left the whole tooltip at the root context's `z-index:
 * auto`, which the Subnav (z-index:49) overpaints. This test guards that the class carrying
 * the stacking rank lands on the Positioner (a positioned element, where z-index builds a
 * stacking context) and not back on the static popup.
 */
import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Provider, Tooltip} from "./Tooltip";

function renderOpenTooltip() {
	return render(
		<Provider>
			<Tooltip content="açıklama" defaultOpen>
				başlık
			</Tooltip>
		</Provider>,
	);
}

describe("Tooltip — stacking rank lives on the Positioner (#2046)", () => {
	it("renders the positioner with the z-index-bearing class", () => {
		renderOpenTooltip();
		// Base UI portals the tooltip to document.body, so query the whole document.
		const positioner = document.querySelector(".kp-tooltip__positioner");
		expect(positioner).not.toBeNull();
	});

	it("the positioner is a positioned element (where z-index establishes a context)", () => {
		renderOpenTooltip();
		const positioner = document.querySelector<HTMLElement>(".kp-tooltip__positioner");
		expect(positioner).not.toBeNull();
		// Base UI sets position inline on the positioner; a z-index on a positioned
		// (non-static) element both builds a stacking context and outranks the sticky
		// Subnav — which a `position: static` popup's z-index never could.
		expect(positioner?.style.position).not.toBe("");
		expect(positioner?.style.position).not.toBe("static");
	});

	it("keeps the popup rendered inside the positioner and off the stacking rank", () => {
		renderOpenTooltip();
		const positioner = document.querySelector<HTMLElement>(".kp-tooltip__positioner");
		const popup = positioner?.querySelector<HTMLElement>(".kp-tooltip__popup");
		expect(popup).not.toBeNull();
		// The static popup must carry no inline z-index — the rank lives on the positioner.
		expect(popup?.style.zIndex).toBe("");
	});
});
