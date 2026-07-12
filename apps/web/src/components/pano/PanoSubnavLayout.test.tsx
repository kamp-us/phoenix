/**
 * pano's persistent product Subnav zone (#2601, placement law #2587). Pins: (1) the zone is a
 * persistent layout — its `.kp-subnav` node survives a within-pano navigation (no remount);
 * (2) the routed feed's filters/meta publish UP into that one zone Subnav (the chip-bridge), so
 * there is a single Subnav, not a per-page second one; (3) the active site-filter folds into the
 * zone as a transient crumb with a working `× filtreyi kaldır` clear — and NO resting-chrome
 * `.kp-pano-crumb` strip is painted.
 */
import {fireEvent, render, screen} from "@testing-library/react";
import {useEffect} from "react";
import {Link, MemoryRouter, Route, Routes} from "react-router";
import {afterEach, describe, expect, it, vi} from "vitest";
import {PanoSubnavLayout, useSetPanoSubnavContent} from "./PanoSubnavLayout";

let signedIn: boolean;
vi.mock("../../auth/client", () => ({
	useSession: () => ({data: signedIn ? {user: {id: "u1"}} : null, isPending: false}),
}));

// A stand-in feed leaf that publishes a fixed Subnav content up into the zone, the same way
// PanoFeed's FeedChrome does — so the test exercises the bridge, not PanoFeed's fate wiring.
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
	useEffect(() => {
		setContent?.({
			filters: [
				{id: "hot", label: "sıcak"},
				{id: "new", label: "yeni"},
			],
			activeFilter: "hot",
			onFilterChange: () => {},
			meta,
			...(host ? {crumb: {label: `site / ${host}`, onClear: () => {}}} : {}),
		});
		return () => setContent?.(null);
	}, [setContent, meta, host]);
	return (
		<div data-testid={testid}>
			<Link to="/pano/x">detay</Link>
		</div>
	);
}

function renderZone(leaf = <PublishingLeaf />) {
	return render(
		<MemoryRouter initialEntries={["/pano"]}>
			<Routes>
				<Route element={<PanoSubnavLayout />}>
					<Route path="/pano" element={leaf} />
					<Route path="/pano/x" element={<div data-testid="pano-detail">detay</div>} />
				</Route>
			</Routes>
		</MemoryRouter>,
	);
}

describe("PanoSubnavLayout — pano product Subnav zone (#2601)", () => {
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

	it("signed in: the primary-action CTA fills the zone's CTA slot", () => {
		signedIn = true;
		renderZone();
		const cta = screen.getByRole("button", {name: "yeni gönderi"});
		expect(cta.className).toContain("kp-btn--primary");
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
		// content cleared on the feed's unmount: filters gone, CTA still present.
		expect(screen.queryByRole("button", {name: "sıcak"})).toBeNull();
		expect(screen.getByRole("button", {name: "yeni gönderi"})).toBeTruthy();
	});

	it("folds the active site-filter into the zone as a transient crumb with a working clear — no resting-chrome strip", () => {
		const {container} = renderZone(<PublishingLeaf host="foo.com" />);
		// Transient crumb paint in the Subnav (accent-faint pill), not the resting .kp-pano-crumb strip.
		expect(container.querySelector(".kp-subnav__crumb")).toBeTruthy();
		expect(container.querySelector(".kp-pano-crumb")).toBeNull();
		expect(screen.getByText("site / foo.com")).toBeTruthy();
		expect(screen.getByRole("button", {name: "× filtreyi kaldır"})).toBeTruthy();
	});
});
