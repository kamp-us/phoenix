/**
 * The persistent product Subnav zone (#2598, placement law #2587). `ProductSubnavLayout`
 * is a pathless layout-route element that renders the product's Subnav above the routed
 * Outlet; React Router keeps that layout element mounted as the user moves within the
 * product's child routes — the "persistent zone, no remount" acceptance criterion. Proven
 * here by DOM-node identity: the `.kp-subnav` node survives a within-product navigation.
 */
import {fireEvent, render, screen} from "@testing-library/react";
import {Link, MemoryRouter, Route, Routes} from "react-router";
import {describe, expect, it} from "vitest";
import {ProductSubnavLayout} from "./ProductSubnavLayout";

function ProductIndex() {
	return (
		<div data-testid="product-index">
			<Link to="/pano/detail">detay</Link>
		</div>
	);
}
function ProductDetail() {
	return <div data-testid="product-detail">detay</div>;
}

describe("ProductSubnavLayout — persistent product Subnav zone (#2598)", () => {
	it("renders the product Subnav zone above the routed Outlet", () => {
		const {container} = render(
			<MemoryRouter initialEntries={["/pano"]}>
				<Routes>
					<Route element={<ProductSubnavLayout />}>
						<Route path="/pano" element={<ProductIndex />} />
					</Route>
				</Routes>
			</MemoryRouter>,
		);
		expect(container.querySelector(".kp-subnav")).toBeTruthy();
		expect(screen.getByTestId("product-index")).toBeTruthy();
	});

	it("keeps the Subnav zone mounted across a within-product navigation — no remount", () => {
		const {container} = render(
			<MemoryRouter initialEntries={["/pano"]}>
				<Routes>
					<Route element={<ProductSubnavLayout />}>
						<Route path="/pano" element={<ProductIndex />} />
						<Route path="/pano/detail" element={<ProductDetail />} />
					</Route>
				</Routes>
			</MemoryRouter>,
		);
		const before = container.querySelector(".kp-subnav");
		expect(before).toBeTruthy();
		expect(screen.getByTestId("product-index")).toBeTruthy();

		fireEvent.click(screen.getByRole("link", {name: "detay"}));

		// The routed Outlet swapped to the detail page…
		expect(screen.getByTestId("product-detail")).toBeTruthy();
		// …but the layout's Subnav zone is the SAME DOM node — the persistent product zone
		// stays mounted across the product's child routes (a remount would replace the node).
		expect(container.querySelector(".kp-subnav")).toBe(before);
	});
});
