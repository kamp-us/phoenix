/**
 * mecmua's persistent product Subnav zone (#2603, placement law #2587). Pins three things:
 * (1) the zone is a persistent layout — its `.kp-subnav` node survives a within-mecmua
 * navigation (no remount); (2) each destination is flag-composed on the SAME seam its
 * route self-gates on, so a link never points at a dark 404 — keşfet on mecmua-public-read,
 * akış on mecmua-feed, yazılarım on the write path (yazar-gated, #2579's missing home);
 * (3) after the SubnavShell migration (ADR 0182), the destinations render INSIDE the bar's
 * sub-destinations zone and the CTA inside the primary-action zone — behavior unchanged.
 */
import {fireEvent, render, screen} from "@testing-library/react";
import {Link, MemoryRouter, Route, Routes} from "react-router";
import {afterEach, describe, expect, it, vi} from "vitest";
import {MECMUA_FEED, MECMUA_PUBLIC_READ, MECMUA_WRITE} from "../../flags/keys";
import {MecmuaSubnavLayout} from "./MecmuaSubnavLayout";

const flags = {read: false, feed: false, write: false};
let signedIn: boolean;
let meTier: string | undefined;
vi.mock("../../auth/client", () => ({
	useSession: () => ({data: signedIn ? {user: {id: "u1"}} : null, isPending: false}),
}));
vi.mock("../../auth/useMe", () => ({
	useMe: () => ({
		me: meTier ? {tier: meTier} : null,
		status: "ok",
		loading: false,
		refetch: vi.fn(),
	}),
}));
vi.mock("../../flags/useFlag", () => ({
	useFlag: (key: string) => ({
		value:
			key === MECMUA_PUBLIC_READ
				? flags.read
				: key === MECMUA_FEED
					? flags.feed
					: key === MECMUA_WRITE
						? flags.write
						: false,
		loading: false,
	}),
}));

function MecmuaIndex() {
	return (
		<div data-testid="mecmua-index">
			<Link to="/mecmua/akis">git</Link>
		</div>
	);
}

function renderZone(initial = "/mecmua") {
	return render(
		<MemoryRouter initialEntries={[initial]}>
			<Routes>
				<Route element={<MecmuaSubnavLayout />}>
					<Route path="/mecmua" element={<MecmuaIndex />} />
					<Route path="/mecmua/akis" element={<div data-testid="mecmua-akis">akış</div>} />
				</Route>
			</Routes>
		</MemoryRouter>,
	);
}

describe("MecmuaSubnavLayout — mecmua product Subnav zone (#2603)", () => {
	afterEach(() => {
		flags.read = false;
		flags.feed = false;
		flags.write = false;
		signedIn = false;
		meTier = undefined;
		vi.clearAllMocks();
	});

	it("renders the mecmua Subnav zone above the routed Outlet", () => {
		const {container} = renderZone();
		expect(container.querySelector(".kp-subnav")).toBeTruthy();
		expect(screen.getByTestId("mecmua-index")).toBeTruthy();
	});

	it("keeps the Subnav zone mounted across a within-mecmua navigation — no remount", () => {
		flags.feed = true;
		const {container} = renderZone();
		const before = container.querySelector(".kp-subnav");
		expect(before).toBeTruthy();
		fireEvent.click(screen.getByRole("link", {name: "git"}));
		expect(screen.getByTestId("mecmua-akis")).toBeTruthy();
		expect(container.querySelector(".kp-subnav")).toBe(before);
	});

	it("composes destinations per flag: keşfet on public-read, akış on feed, all flag-off ⇒ none", () => {
		renderZone();
		expect(screen.queryByRole("link", {name: "keşfet"})).toBeNull();
		expect(screen.queryByRole("link", {name: "akış"})).toBeNull();
		expect(screen.queryByRole("link", {name: "yazılarım"})).toBeNull();
	});

	it("read flag on ⇒ keşfet destination points at the public index /mecmua", () => {
		flags.read = true;
		renderZone();
		expect(screen.getByRole("link", {name: "keşfet"}).getAttribute("href")).toBe("/mecmua");
	});

	it("feed flag on ⇒ akış destination points at /mecmua/akis (moved out of the topbar)", () => {
		flags.feed = true;
		renderZone();
		expect(screen.getByRole("link", {name: "akış"}).getAttribute("href")).toBe("/mecmua/akis");
	});

	it("write flag on + yazar ⇒ yazılarım destination appears (its nav home, #2579) and points at /mecmua/yazilarim", () => {
		flags.write = true;
		signedIn = true;
		meTier = "yazar";
		renderZone();
		expect(screen.getByRole("link", {name: "yazılarım"}).getAttribute("href")).toBe(
			"/mecmua/yazilarim",
		);
	});

	it("write flag on but çaylak ⇒ no yazılarım destination (gate parity with the editor, no dead-end)", () => {
		flags.write = true;
		signedIn = true;
		meTier = "caylak";
		renderZone();
		expect(screen.queryByRole("link", {name: "yazılarım"})).toBeNull();
	});

	// Zone-through-shell (ADR 0182): the destinations fill the shell's one sub-destinations
	// zone (inside the bar, never a detached sibling) and the CTA fills the primary-action zone.
	it("renders the destinations INSIDE the shell's sub-destinations zone — no detached sibling", () => {
		flags.read = true;
		const {container} = renderZone();
		const kesfet = screen.getByRole("link", {name: "keşfet"});
		const filters = container.querySelector(".kp-subnav__filters");
		expect(filters?.contains(kesfet)).toBe(true);
	});

	it("renders the CTA in the shell's primary-action zone when the author can write", () => {
		flags.write = true;
		signedIn = true;
		meTier = "yazar";
		const {container} = renderZone();
		const cta = screen.getByRole("button", {name: "yeni yazı"});
		expect(container.querySelector(".kp-subnav__cta")?.contains(cta)).toBe(true);
	});
});
