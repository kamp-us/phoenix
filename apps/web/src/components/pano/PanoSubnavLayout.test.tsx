/** pano's persistent Subnav zone, composed through SubnavShell. See ADR 0182. */
import {fireEvent, render, screen, within} from "@testing-library/react";
import {useEffect} from "react";
import {Link, MemoryRouter, Route, Routes, useLocation, useNavigate} from "react-router";
import {afterEach, describe, expect, it, vi} from "vitest";
import {PanoSubnavLayout, useSetPanoSubnavContent} from "./PanoSubnavLayout";

let signedIn: boolean;
vi.mock("../../auth/client", () => ({
	useSession: () => ({data: signedIn ? {user: {id: "u1"}} : null, isPending: false}),
}));

// Stands in for PanoFeed's FeedChrome so the test exercises the bridge, not PanoFeed's
// fate wiring.
function PublishingLeaf({
	meta = "3 başlık",
	host,
	testid = "leaf",
}: {
	meta?: string;
	host?: string;
	testid?: string;
}) {
	const setContent = useSetPanoSubnavContent();
	const navigate = useNavigate();
	useEffect(() => {
		setContent?.({
			filters: [
				{id: "hot", label: "sıcak"},
				{id: "new", label: "yeni"},
			],
			activeFilter: "hot",
			onFilterChange: () => {},
			meta,
			...(host
				? {
						crumb: {
							trail: [{key: "site", label: "site"}],
							current: {key: "host", label: host},
							onClear: () => navigate("/pano"),
						},
					}
				: {}),
		});
		return () => setContent?.(null);
	}, [setContent, navigate, meta, host]);
	return (
		<div data-testid={testid}>
			<Link to="/pano/x">detay</Link>
		</div>
	);
}

function LocationProbe() {
	return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderZone(leaf = <PublishingLeaf />, entry = "/pano") {
	return render(
		<MemoryRouter initialEntries={[entry]}>
			<LocationProbe />
			<Routes>
				<Route element={<PanoSubnavLayout />}>
					<Route path="/pano" element={leaf} />
					<Route path="/pano/site/:host" element={leaf} />
					<Route path="/pano/x" element={<div data-testid="pano-detail">detay</div>} />
				</Route>
			</Routes>
		</MemoryRouter>,
	);
}

describe("PanoSubnavLayout — pano product Subnav zone through SubnavShell (#2975)", () => {
	afterEach(() => {
		signedIn = false;
		vi.clearAllMocks();
	});

	it("renders one Subnav zone above the routed Outlet", () => {
		const {container} = renderZone();
		expect(container.querySelectorAll(".kp-subnav")).toHaveLength(1);
		expect(screen.getByTestId("leaf")).toBeTruthy();
	});

	it("publishes the feed's filters + meta up into the zone Subnav", () => {
		renderZone();
		expect(screen.getByRole("button", {name: "sıcak"})).toBeTruthy();
		expect(screen.getByRole("button", {name: "yeni"})).toBeTruthy();
		expect(screen.getByText("3 başlık")).toBeTruthy();
	});

	it("lands pano's content in the shell's typed zones — chips in destinations, meta in signal", () => {
		signedIn = true;
		const {container} = renderZone(<PublishingLeaf host="foo.com" />);
		const bar = container.querySelector(".kp-subnav");
		const filtersRow = bar?.querySelector(".kp-subnav__filters");
		expect(filtersRow?.contains(screen.getByRole("button", {name: "sıcak"}))).toBe(true);
		expect(filtersRow?.contains(screen.getByRole("button", {name: "yeni"}))).toBe(true);
		expect(
			bar
				?.querySelector(".kp-subnav__leading")
				?.contains(screen.getByRole("navigation", {name: "sayfa yolu"})),
		).toBe(true);
		expect(
			bar
				?.querySelector(".kp-subnav__cta")
				?.contains(screen.getByRole("button", {name: "yeni gönderi"})),
		).toBe(true);
		expect(bar?.querySelector(".kp-subnav__meta")?.textContent).toContain("3 başlık");
	});

	it("signed in: the primary-action CTA fills the zone's CTA slot", () => {
		signedIn = true;
		renderZone();
		const cta = screen.getByRole("button", {name: "yeni gönderi"});
		expect(cta.getAttribute("data-variant")).toBe("primary");
	});

	it("keeps the Subnav zone mounted across a within-pano navigation — no remount", () => {
		const {container} = renderZone();
		const before = container.querySelector(".kp-subnav");
		expect(before).toBeTruthy();
		fireEvent.click(screen.getByRole("link", {name: "detay"}));
		expect(screen.getByTestId("pano-detail")).toBeTruthy();
		expect(container.querySelector(".kp-subnav")).toBe(before);
	});

	it("clears to just the CTA when leaving the feed for a non-feed /pano route", () => {
		signedIn = true;
		renderZone();
		expect(screen.getByRole("button", {name: "sıcak"})).toBeTruthy();
		fireEvent.click(screen.getByRole("link", {name: "detay"}));
		expect(screen.queryByRole("button", {name: "sıcak"})).toBeNull();
		expect(screen.getByRole("button", {name: "yeni gönderi"})).toBeTruthy();
	});

	it("folds the active site-filter into the zone as a transient crumb with a working clear — no resting-chrome strip", () => {
		const {container} = renderZone(<PublishingLeaf host="foo.com" />);
		expect(container.querySelector(".kp-subnav__crumb")).toBeTruthy();
		expect(container.querySelector(".kp-pano-crumb")).toBeNull();
		expect(screen.getByRole("navigation", {name: "sayfa yolu"}).textContent).toBe("site / foo.com");
		expect(screen.getByRole("button", {name: "× filtreyi kaldır"})).toBeTruthy();
	});
});

/** Each crumb's text with its `aria-hidden` parts removed: what assistive tech reads per item. */
function spokenCrumbs(nav: HTMLElement): string[] {
	return within(nav)
		.getAllByRole("listitem")
		.map((item) => {
			const copy = item.cloneNode(true) as HTMLElement;
			for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
			return copy.textContent ?? "";
		});
}

describe("PanoSubnavLayout — the zoned site-filter crumb is a WAI-ARIA breadcrumb (#9705)", () => {
	function renderSiteCrumb() {
		renderZone(<PublishingLeaf host="example.com" />, "/pano/site/example.com");
		return screen.getByRole("navigation", {name: "sayfa yolu"});
	}

	it("renders inside a named nav landmark as an ordered list", () => {
		const nav = renderSiteCrumb();
		expect(within(nav).getByRole("list").tagName).toBe("OL");
		expect(spokenCrumbs(nav)).toEqual(["site", "example.com"]);
	});

	it("hides the separators from assistive tech", () => {
		const nav = renderSiteCrumb();
		const seps = nav.querySelectorAll(".kp-breadcrumbs__sep");
		expect(seps).toHaveLength(1);
		for (const sep of seps) expect(sep.getAttribute("aria-hidden")).toBe("true");
	});

	it("marks the host crumb, and only it, as the current page", () => {
		const nav = renderSiteCrumb();
		const current = nav.querySelectorAll("[aria-current]");
		expect(current).toHaveLength(1);
		expect(current[0]?.getAttribute("aria-current")).toBe("page");
		expect(within(nav).getAllByRole("listitem").at(-1)).toBe(current[0]);
	});

	it("keeps the clear control outside the list, and clearing navigates to /pano", () => {
		const nav = renderSiteCrumb();
		const clear = screen.getByRole("button", {name: "× filtreyi kaldır"});
		expect(nav.contains(clear)).toBe(false);
		fireEvent.click(clear);
		expect(screen.getByTestId("location").textContent).toBe("/pano");
	});
});
