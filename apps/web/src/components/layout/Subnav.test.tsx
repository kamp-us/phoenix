/**
 * The Subnav CTA slot (#2598, placement law #2587) — the dedicated primary-action
 * position. A passed `cta` node renders in `.kp-subnav__cta`; absent, nothing renders. The
 * slot positions only — it never wraps the node in the utility filter/tab treatment
 * (`.kp-subnav__filter`), per the #2586 taxonomy / #2590 IA rule.
 */
import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Subnav} from "./Subnav";

describe("Subnav CTA slot (#2598)", () => {
	it("renders the passed cta node in the dedicated primary-action slot", () => {
		const {container} = render(
			<Subnav
				cta={
					<button type="button" data-testid="cta-btn">
						yeni
					</button>
				}
			/>,
		);
		const slot = container.querySelector(".kp-subnav__cta");
		expect(slot).toBeTruthy();
		expect(screen.getByTestId("cta-btn")).toBeTruthy();
		// The CTA is NOT styled as a utility filter/tab — the slot carries no filter class,
		// and the substrate paints no filter treatment anywhere on a CTA-only Subnav.
		expect(slot?.querySelector(".kp-subnav__filter")).toBeNull();
		expect(container.querySelector(".kp-subnav__filter")).toBeNull();
	});

	it("renders no cta slot when no cta is passed", () => {
		const {container} = render(<Subnav />);
		expect(container.querySelector(".kp-subnav__cta")).toBeNull();
	});
});
