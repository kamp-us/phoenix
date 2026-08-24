/**
 * `/hosgeldin` route contract (#7043, epic #4304). The rows that lose silently if the
 * gate order is "simplified": the dark route 404s, the resolving flag shows a neutral
 * placeholder instead of flashing that 404, arrival writes the shown-once marker so a
 * reload or repeat login bounces straight to the `returnTo`, an unvouched çaylak gets
 * the settled vouch-needed copy and NO promotion bar (#4261), and the whole moment is
 * one screen with one exit.
 */
import {fireEvent, render, screen} from "@testing-library/react";
import {MemoryRouter, Route, Routes, useLocation} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {WELCOME_SEEN_SCHEMA, welcomeSeenKey} from "../components/onboarding/welcomeSeen";
import {WelcomePage} from "./WelcomePage";
import {WELCOME_PATH} from "./welcomeGating";

const flag = {value: false, loading: false};
let signedIn = true;
let sessionPending = false;
let tier: string | null = "çaylak";
// The `myAuthorshipStanding` read, pinned per test through the mocked imperative view.
let standingState: {status: string; data: unknown} = {
	status: "ok",
	data: {id: "s-1", karma: 3, bar: 15, vouchExists: false, inReviewCount: 0},
};

vi.mock("../auth/client", () => ({
	useSession: () => ({
		data: signedIn ? {user: {id: "u-1"}} : null,
		isPending: sessionPending,
	}),
}));
vi.mock("../auth/useMe", () => ({
	useMe: () => ({
		me: tier ? {id: "u-1", tier} : null,
		status: "ok",
		loading: false,
		refetch: vi.fn(),
	}),
}));
vi.mock("../flags/useFlag", () => ({useFlag: () => flag}));
vi.mock("../fate/useImperativeView", () => ({
	useImperativeView: () => ({state: standingState, refetch: vi.fn()}),
}));

function LocationProbe({label}: {label: string}) {
	const location = useLocation();
	return <div data-testid={label}>{`${location.pathname}${location.search}`}</div>;
}

function renderRoute(initialEntry = `${WELCOME_PATH}?returnTo=${encodeURIComponent("/pano")}`) {
	return render(
		<MemoryRouter initialEntries={[initialEntry]}>
			<Routes>
				<Route path={WELCOME_PATH} element={<WelcomePage />} />
				<Route path="/pano" element={<LocationProbe label="pano-probe" />} />
				<Route path="/auth" element={<LocationProbe label="auth-probe" />} />
				<Route path="/" element={<LocationProbe label="home-probe" />} />
			</Routes>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	localStorage.clear();
	flag.value = false;
	flag.loading = false;
	signedIn = true;
	sessionPending = false;
	tier = "çaylak";
	standingState = {
		status: "ok",
		data: {id: "s-1", karma: 3, bar: 15, vouchExists: false, inReviewCount: 0},
	};
});

afterEach(() => {
	localStorage.clear();
});

describe("WelcomePage — the flag-dark gate (.patterns/flag-dark-page-gate.md)", () => {
	it("self-404s with phoenix-welcome off (criterion 1)", () => {
		renderRoute();
		expect(screen.getByTestId("not-found-page")).toBeTruthy();
		expect(screen.queryByTestId("welcome-page")).toBeNull();
	});

	it("shows a neutral placeholder while the flag resolves — no 404 flash", () => {
		flag.loading = true;
		renderRoute();
		expect(screen.getByTestId("welcome-loading")).toBeTruthy();
		expect(screen.queryByTestId("not-found-page")).toBeNull();
	});

	it("redirects a signed-out visitor to auth carrying a returnTo back", () => {
		flag.value = true;
		signedIn = false;
		tier = null;
		renderRoute();
		expect(screen.getByTestId("auth-probe").textContent).toBe(
			`/auth?returnTo=${encodeURIComponent("/pano")}`,
		);
	});
});

describe("WelcomePage — one screen answering #4266's three questions", () => {
	it("renders what-this-is, where-you-stand and the rite ahead — with exactly one exit", () => {
		flag.value = true;
		renderRoute();
		expect(screen.getByTestId("welcome-page").tagName).toBe("MAIN");
		expect(screen.getByTestId("welcome-standing")).toBeTruthy();
		expect(screen.getByTestId("welcome-rite")).toBeTruthy();
		// One screen, no second step: a single control leaves the surface.
		expect(screen.getAllByTestId("welcome-continue")).toHaveLength(1);
		expect(document.querySelectorAll("button")).toHaveLength(1);
	});

	it("greets a çaylak in the founder's ruled words — 'hoş geldin, çaylak' (#4266)", () => {
		flag.value = true;
		renderRoute();
		expect(screen.getByTestId("welcome-title").textContent).toBe("hoş geldin, çaylak");
	});
});

describe("WelcomePage — honest framing for the unvouched çaylak (#4261, criterion 5)", () => {
	it("shows vouch-needed copy and kefil yok — never a promotion bar", () => {
		flag.value = true;
		renderRoute();
		const vouchNeeded = screen.getByTestId("welcome-vouch-needed");
		expect(vouchNeeded.textContent).toContain("bir yazar sana kefil olmalı");
		expect(vouchNeeded.textContent).toContain("ya da bir moderatör seni doğrudan yükseltebilir");
		expect(screen.getByTestId("welcome-vouch").textContent).toBe("yok");
		expect(screen.queryByTestId("welcome-karma")).toBeNull();
	});

	it("a vouched çaylak gets the honest reduced bar and kefil var", () => {
		flag.value = true;
		standingState = {
			status: "ok",
			data: {id: "s-1", karma: 7, bar: 15, vouchExists: true, inReviewCount: 0},
		};
		renderRoute();
		expect(screen.queryByTestId("welcome-vouch-needed")).toBeNull();
		expect(screen.getByTestId("welcome-karma")).toBeTruthy();
		expect(screen.getByTestId("welcome-vouch").textContent).toBe("var");
	});

	it("never addresses a yazar as a çaylak", () => {
		flag.value = true;
		tier = "yazar";
		renderRoute();
		expect(screen.getByTestId("welcome-yazar-note")).toBeTruthy();
		expect(screen.queryByTestId("welcome-vouch-needed")).toBeNull();
		// The greeting drops the tier word rather than calling a yazar a çaylak.
		expect(screen.getByTestId("welcome-title").textContent).toBe("hoş geldin");
	});
});

describe("WelcomePage — shown-once persistence (criterion 4)", () => {
	it("arrival writes the per-account marker", () => {
		flag.value = true;
		renderRoute();
		expect(localStorage.getItem(welcomeSeenKey(WELCOME_SEEN_SCHEMA, "u-1"))).toBe("1");
	});

	it("a reload lands past the surface — straight to the original returnTo", () => {
		flag.value = true;
		const first = renderRoute();
		first.unmount();
		// The reload re-mounts the page fresh over the persisted marker.
		renderRoute();
		expect(screen.queryByTestId("welcome-page")).toBeNull();
		expect(screen.getByTestId("pano-probe").textContent).toBe("/pano");
	});

	it("repeat login suppresses too — the marker outlives any session object", () => {
		flag.value = true;
		const first = renderRoute();
		first.unmount();
		// A later login hands the component a brand-new session object; same account id.
		renderRoute();
		expect(screen.getByTestId("pano-probe")).toBeTruthy();
	});

	it("another account on the same browser is not suppressed by u-1's marker", () => {
		flag.value = true;
		localStorage.setItem(welcomeSeenKey(WELCOME_SEEN_SCHEMA, "u-other"), "1");
		renderRoute();
		expect(screen.getByTestId("welcome-page")).toBeTruthy();
	});
});

describe("WelcomePage — continuing returns to context (criterion 2)", () => {
	it("devam et navigates to the carried returnTo", () => {
		flag.value = true;
		renderRoute();
		fireEvent.click(screen.getByTestId("welcome-continue"));
		expect(screen.getByTestId("pano-probe").textContent).toBe("/pano");
	});

	it("without a returnTo param the cold fallback is /", () => {
		flag.value = true;
		renderRoute(WELCOME_PATH);
		fireEvent.click(screen.getByTestId("welcome-continue"));
		expect(screen.getByTestId("home-probe").textContent).toBe("/");
	});
});
