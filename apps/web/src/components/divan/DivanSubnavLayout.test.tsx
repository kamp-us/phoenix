/**
 * divan's persistent product Subnav zone (#2604, placement law #2587). Pins: (1) the zone is a
 * persistent layout — its `.kp-subnav` node survives a within-divan navigation (no remount); (2)
 * the routed page publishes its çaylaklar ↔ raporlar section switch UP into the zone, where it
 * renders as Subnav filters (`.kp-subnav__filter` — the #2586 taxonomy switcher treatment, never a
 * resting boxed `.kp-divan__nav-tab` pill); (3) a switch click drives the published onFilterChange;
 * (4) a non-mod page (no second section) publishes null and the zone shows the bare substrate bar;
 * (5) with NO zone ancestor (flag off) the publish hook returns null — the signal DivanWorkspace
 * uses to keep painting its own in-page nav byte-identically as today; (6) the switcher renders
 * through SubnavShell INSIDE the bar's `.kp-subnav__filters` row (ADR 0182 destinations zone),
 * never a detached sibling.
 */
import {fireEvent, render, screen} from "@testing-library/react";
import {useEffect, useState} from "react";
import {Link, MemoryRouter, Route, Routes} from "react-router";
import {describe, expect, it} from "vitest";
import {DivanSubnavLayout, useSetDivanSubnavContent} from "./DivanSubnavLayout";

const SECTION_FILTERS = [
	{id: "caylaklar", label: "çaylaklar"},
	{id: "raporlar", label: "raporlar"},
];

/** A stand-in for DivanWorkspace: publishes the section switch up exactly as the page does. */
function FakeDivanLeaf({hasSwitch = true}: {hasSwitch?: boolean}) {
	const setDivanSubnav = useSetDivanSubnavContent();
	const [section, setSection] = useState("caylaklar");
	useEffect(() => {
		if (!setDivanSubnav) return;
		setDivanSubnav(
			hasSwitch
				? {filters: SECTION_FILTERS, activeFilter: section, onFilterChange: setSection}
				: null,
		);
	}, [setDivanSubnav, hasSwitch, section]);
	return (
		<div data-testid="divan-leaf">
			section:{section}
			<Link to="/divan/other">başka</Link>
		</div>
	);
}

function renderZone(hasSwitch = true, initial = "/divan") {
	return render(
		<MemoryRouter initialEntries={[initial]}>
			<Routes>
				<Route element={<DivanSubnavLayout />}>
					<Route path="/divan" element={<FakeDivanLeaf hasSwitch={hasSwitch} />} />
					<Route path="/divan/other" element={<FakeDivanLeaf hasSwitch={hasSwitch} />} />
				</Route>
			</Routes>
		</MemoryRouter>,
	);
}

describe("DivanSubnavLayout — divan product Subnav zone (#2604)", () => {
	it("renders one persistent Subnav zone carrying the published section switchers above the Outlet", () => {
		const {container} = renderZone();
		expect(container.querySelectorAll(".kp-subnav")).toHaveLength(1);
		const switchers = container.querySelectorAll(".kp-subnav__filter");
		expect(switchers).toHaveLength(2);
		expect(screen.getByRole("button", {name: "çaylaklar"})).toBeTruthy();
		expect(screen.getByRole("button", {name: "raporlar"})).toBeTruthy();
		expect(screen.getByTestId("divan-leaf")).toBeTruthy();
	});

	it("renders the switcher through SubnavShell INSIDE the bar's filters row, not a detached sibling (ADR 0182)", () => {
		const {container} = renderZone();
		// the destinations zone lives inside the shell's bar — the switcher buttons are descendants
		// of `.kp-subnav > .kp-subnav__filters`, closing the orphaned-sibling composition class.
		const inBar = container.querySelectorAll(".kp-subnav .kp-subnav__filters .kp-subnav__filter");
		expect(inBar).toHaveLength(2);
	});

	it("carries the switchers as taxonomy filters — one taxonomy class, no resting boxed pill (#2586/#2590)", () => {
		const {container} = renderZone();
		for (const el of container.querySelectorAll(".kp-subnav__filter")) {
			// exactly the taxonomy filter class — never the resting-boxed `.kp-divan__nav-tab` pill
			expect(el.classList.contains("kp-divan__nav-tab")).toBe(false);
		}
		expect(container.querySelector(".kp-divan__nav")).toBeNull();
	});

	it("reflects the active section via aria-pressed and drives the switch on click", () => {
		renderZone();
		const caylaklar = screen.getByRole("button", {name: "çaylaklar"});
		const raporlar = screen.getByRole("button", {name: "raporlar"});
		expect(caylaklar.getAttribute("aria-pressed")).toBe("true");
		expect(raporlar.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(raporlar);
		expect(screen.getByTestId("divan-leaf").textContent).toContain("section:raporlar");
		expect(screen.getByRole("button", {name: "raporlar"}).getAttribute("aria-pressed")).toBe(
			"true",
		);
	});

	it("shows the bare substrate bar when the page has no second section (non-mod publishes null)", () => {
		const {container} = renderZone(false);
		expect(container.querySelectorAll(".kp-subnav")).toHaveLength(1);
		expect(container.querySelectorAll(".kp-subnav__filter")).toHaveLength(0);
	});

	it("keeps the Subnav zone mounted across a within-divan navigation — no remount", () => {
		const {container} = renderZone();
		const before = container.querySelector(".kp-subnav");
		expect(before).toBeTruthy();
		fireEvent.click(screen.getByRole("link", {name: "başka"}));
		expect(container.querySelector(".kp-subnav")).toBe(before);
	});

	it("with no zone ancestor (flag off) the publish hook is null — the in-page-nav fallback signal", () => {
		let observed: unknown = "unset";
		function Probe() {
			observed = useSetDivanSubnavContent();
			return null;
		}
		render(<Probe />);
		expect(observed).toBeNull();
	});
});
