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

		expect(screen.getByTestId("product-detail")).toBeTruthy();
		expect(container.querySelector(".kp-subnav")).toBe(before);
	});
});

describe("ProductSubnavLayout — composes through SubnavShell (#2978, ADR 0182)", () => {
	it("preserves the cta contract — hands cta to the shell's primaryAction zone, rendered in .kp-subnav__cta", () => {
		const {container} = render(
			<MemoryRouter initialEntries={["/pano"]}>
				<Routes>
					<Route
						element={
							<ProductSubnavLayout
								cta={
									<button type="button" data-testid="cta">
										yeni
									</button>
								}
							/>
						}
					>
						<Route path="/pano" element={<ProductIndex />} />
					</Route>
				</Routes>
			</MemoryRouter>,
		);
		const bar = container.querySelector(".kp-subnav");
		expect(bar?.querySelector(".kp-subnav__cta")?.contains(screen.getByTestId("cta"))).toBe(true);
	});
});
