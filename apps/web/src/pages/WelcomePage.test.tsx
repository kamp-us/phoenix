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
import {installFakeStorage} from "../../tests/client/fakeStorage";
import {firstContributionDismissKey} from "../components/onboarding/firstContribution";
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

const DEFAULT_ENTRY = `${WELCOME_PATH}?returnTo=${encodeURIComponent("/pano")}`;

function routeTree(initialEntry: string) {
	return (
		<MemoryRouter initialEntries={[initialEntry]}>
			<Routes>
				<Route path={WELCOME_PATH} element={<WelcomePage />} />
				<Route path="/pano" element={<LocationProbe label="pano-probe" />} />
				<Route path="/auth" element={<LocationProbe label="auth-probe" />} />
				<Route path="/" element={<LocationProbe label="home-probe" />} />
			</Routes>
		</MemoryRouter>
	);
}

function renderRoute(initialEntry = DEFAULT_ENTRY) {
	const view = render(routeTree(initialEntry));
	// Re-render the SAME mounted tree, the way a resolving session re-renders a live page —
	// distinct from `renderRoute()` again, which is a fresh mount (a reload).
	return {...view, settle: () => view.rerender(routeTree(initialEntry))};
}

beforeEach(() => {
	installFakeStorage();
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
	vi.unstubAllGlobals();
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
		// One screen, no second step: `devam et` is the only control that ends the moment.
		expect(screen.getAllByTestId("welcome-continue")).toHaveLength(1);
		// #7044's ask adds one dismiss beside it — an ask the reader may decline, not a step.
		expect(document.querySelectorAll("button")).toHaveLength(2);
		expect(screen.getByTestId("first-contribution-dismiss")).toBeTruthy();
	});

	it("is back to its single control once the ask is declined", () => {
		flag.value = true;
		renderRoute();
		fireEvent.click(screen.getByTestId("first-contribution-dismiss"));
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

	// REGRESSION: a real reload paints with `session.isPending` true, so the account id is
	// not knowable yet. Freezing the marker read at mount latched `false` for the null id and
	// re-showed the welcome once the session landed — the suppression this criterion buys.
	it("a reload whose session is still pending still suppresses once the account lands", () => {
		flag.value = true;
		installFakeStorage({[welcomeSeenKey(WELCOME_SEEN_SCHEMA, "u-1")]: "1"});
		sessionPending = true;
		signedIn = false;
		const {settle} = renderRoute();
		expect(screen.getByTestId("welcome-loading")).toBeTruthy();

		// The session resolves into the SAME mounted component, as it does on a real reload.
		sessionPending = false;
		signedIn = true;
		settle();

		expect(screen.queryByTestId("welcome-page")).toBeNull();
		expect(screen.getByTestId("pano-probe").textContent).toBe("/pano");
	});

	it("another account on the same browser is not suppressed by u-1's marker", () => {
		flag.value = true;
		localStorage.setItem(welcomeSeenKey(WELCOME_SEEN_SCHEMA, "u-other"), "1");
		renderRoute();
		expect(screen.getByTestId("welcome-page")).toBeTruthy();
	});
});

describe("WelcomePage — the first-contribution ask (#7044)", () => {
	it("offers the çaylak the ask, pointed at sözlük on a cold arrival", () => {
		flag.value = true;
		renderRoute();
		expect(screen.getByTestId("first-contribution-nudge")).toBeTruthy();
		expect(screen.getByTestId("first-contribution-go").getAttribute("href")).toBe("/sozluk");
	});

	it("points a başlık arrival at that başlık", () => {
		flag.value = true;
		renderRoute(`${WELCOME_PATH}?returnTo=${encodeURIComponent("/sozluk/monad")}`);
		expect(screen.getByTestId("first-contribution-go").getAttribute("href")).toBe("/sozluk/monad");
		expect(screen.getByTestId("first-contribution-copy").textContent).toContain("monad");
	});

	it("never asks a yazar — the ladder decides, not the copy", () => {
		flag.value = true;
		tier = "yazar";
		renderRoute();
		expect(screen.queryByTestId("first-contribution-nudge")).toBeNull();
	});

	it("dismissal persists across a reload — the ask never returns", () => {
		flag.value = true;
		const first = renderRoute();
		fireEvent.click(screen.getByTestId("first-contribution-dismiss"));
		expect(screen.queryByTestId("first-contribution-nudge")).toBeNull();
		first.unmount();

		// A reload of the surface itself: the welcome's own marker would bounce a returning
		// account, so read the dismissal back on a browser where only it was set.
		installFakeStorage({[firstContributionDismissKey("u-1")]: "1"});
		renderRoute();
		expect(screen.getByTestId("welcome-page")).toBeTruthy();
		expect(screen.queryByTestId("first-contribution-nudge")).toBeNull();
	});

	it("another account on the same browser is still asked", () => {
		flag.value = true;
		installFakeStorage({[firstContributionDismissKey("u-other")]: "1"});
		renderRoute();
		expect(screen.getByTestId("first-contribution-nudge")).toBeTruthy();
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
