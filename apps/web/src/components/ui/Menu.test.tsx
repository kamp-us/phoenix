import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Menu} from "./Menu";

function renderOpenMenu() {
	return render(
		<Menu
			open
			trigger={<button type="button">aç</button>}
			items={[{value: "notifications", label: "Bildirimler"}]}
		/>,
	);
}

describe("Menu — Manti portal anatomy", () => {
	it("renders the menu content inside its positioned portal node", () => {
		renderOpenMenu();
		const positioner = document.querySelector('[data-scope="menu"][data-part="positioner"]');
		expect(positioner).not.toBeNull();
		expect(positioner?.querySelector('[data-scope="menu"][data-part="content"]')).not.toBeNull();
	});

	it("renders commands as native menu items", () => {
		renderOpenMenu();
		expect(screen.getByRole("menuitem", {name: "Bildirimler"})).not.toBeNull();
	});
});
