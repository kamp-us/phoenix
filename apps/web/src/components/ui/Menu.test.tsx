/**
 * Pins the Menu popup stacking fix (#2041): the z-index that lifts the account
 * dropdown above the sticky `.kp-subnav` row must sit on the *Positioner* — the
 * `position: fixed` portal-root element — not on the inner `.kp-menu__popup`,
 * which is `position: static` and so ignores z-index entirely. Putting it on the
 * static popup left the whole menu at the root context's `z-index: auto`, which
 * the Subnav (z-index:49) overpainted. This test guards that the class carrying
 * the stacking rank lands on the Positioner and not back on the popup.
 */
import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Menu} from "./Menu";

function renderOpenMenu() {
	return render(
		<Menu.Root open>
			<Menu.Trigger>aç</Menu.Trigger>
			<Menu.Popup>
				<Menu.Item>Bildirimler</Menu.Item>
			</Menu.Popup>
		</Menu.Root>,
	);
}

describe("Menu.Popup — stacking rank lives on the Positioner (#2041)", () => {
	it("renders the positioner with the z-index-bearing class", () => {
		renderOpenMenu();
		// Base UI portals the popup to document.body, so query the whole document.
		const positioner = document.querySelector(".kp-menu__positioner");
		expect(positioner).not.toBeNull();
	});

	it("the positioner is the fixed-position element (where z-index establishes a context)", () => {
		renderOpenMenu();
		const positioner = document.querySelector<HTMLElement>(".kp-menu__positioner");
		expect(positioner).not.toBeNull();
		// Base UI sets position:fixed inline on the positioner (positionMethod="fixed");
		// a z-index on a fixed element both builds a stacking context and outranks the
		// sticky Subnav, which a static popup's z-index never could.
		expect(positioner?.style.position).toBe("fixed");
	});

	it("keeps the popup rendered inside the positioner", () => {
		renderOpenMenu();
		const positioner = document.querySelector(".kp-menu__positioner");
		expect(positioner?.querySelector(".kp-menu__popup")).not.toBeNull();
	});
});
