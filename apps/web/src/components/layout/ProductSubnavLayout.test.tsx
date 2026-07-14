/**
 * The persistent product Subnav zone (#2598, placement law #2587), now composed through
 * `SubnavShell` (#2978, ADR 0182). `ProductSubnavLayout` is a pathless layout-route element
 * that renders the product's subnav above the routed Outlet; React Router keeps that layout
 * element mounted as the user moves within the product's child routes — the "persistent zone,
 * no remount" acceptance criterion, proven by DOM-node identity across a within-product nav.
 * Two further properties are asserted: the substrate renders THROUGH `SubnavShell` (spied
 * below — the shell receives the frame's `cta` as its `primaryAction` zone), and the `cta`
 * contract is preserved unchanged (it still lands in the bar's `.kp-subnav__cta` slot).
 */
import {fireEvent, render, screen} from "@testing-library/react";
import {Link, MemoryRouter, Route, Routes} from "react-router";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {ProductSubnavLayout} from "./ProductSubnavLayout";
import * as SubnavShellModule from "./SubnavShell";

// Spy the real SubnavShell through a passthrough mock: the actual shell still renders (so the
// DOM-level persistence + cta-contract assertions exercise real composition), while the spy
// records the props the substrate handed it — that is how "renders through SubnavShell" is
// asserted. Against the pre-refactor `<Subnav>` wiring this spy is never called, so those
// assertions fail — the TDD guard on the refactor.
vi.mock("./SubnavShell", async (importActual) => {
	const actual = await importActual<typeof import("./SubnavShell")>();
	return {...actual, SubnavShell: vi.fn(actual.SubnavShell)};
});

const subnavShellSpy = vi.mocked(SubnavShellModule.SubnavShell);

beforeEach(() => {
	subnavShellSpy.mockClear();
});

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

describe("ProductSubnavLayout — composes through SubnavShell (#2978, ADR 0182)", () => {
	it("renders the substrate frame THROUGH SubnavShell", () => {
		render(
			<MemoryRouter initialEntries={["/pano"]}>
				<Routes>
					<Route element={<ProductSubnavLayout />}>
						<Route path="/pano" element={<ProductIndex />} />
					</Route>
				</Routes>
			</MemoryRouter>,
		);
		// The bar is emitted by the shell, not by a directly-wired <Subnav>.
		expect(subnavShellSpy).toHaveBeenCalled();
	});

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
		// The frame's cta is routed to the shell's primaryAction zone (ADR 0182's one promoted verb)…
		expect(subnavShellSpy.mock.calls[0]?.[0]?.primaryAction).toBeTruthy();
		// …and still lands in the bar's dedicated cta slot — the pre-refactor `cta` contract, unchanged.
		const bar = container.querySelector(".kp-subnav");
		expect(bar?.querySelector(".kp-subnav__cta")?.contains(screen.getByTestId("cta"))).toBe(true);
	});
});
