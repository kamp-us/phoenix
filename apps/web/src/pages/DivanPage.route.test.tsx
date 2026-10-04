/**
 * The divan section is addressable by URL (#8776). Before this, raporlar existed only after
 * an in-page click, so a renderer that only navigates — `review-ui` — could never paint
 * `.kp-divan__raporlar-pane` or `.kp-divan__decisions-pane`, and no moderator could share a
 * link into them.
 *
 * The routes below are wired off the same `DIVAN_PATH` / `DIVAN_RAPORLAR_PATH` constants
 * `App.tsx` mounts, so a path drift on either side fails here. The fate-backed children are
 * stubbed inert: what is under test is which panes the route puts in the tree.
 */
import {fireEvent, render, screen} from "@testing-library/react";
import {MemoryRouter, Route, Routes, useLocation} from "react-router";
import {describe, expect, it, vi} from "vitest";
import {DIVAN_PATH, DIVAN_RAPORLAR_PATH} from "../components/divan/divanSection";
import {DivanPage} from "./DivanPage";

let isModerator = false;

vi.mock("../auth/useMe", () => ({
	useMe: () => ({
		me: {id: "u-1", tier: "yazar", isModerator},
		status: "ok",
		loading: false,
		refetch: async () => {},
	}),
}));

vi.mock("../components/divan/DivanRoster", () => ({
	DivanRoster: () => <div data-testid="roster-stub" />,
}));
vi.mock("../components/divan/Raporlar", () => ({Raporlar: () => <div data-testid="grid-stub" />}));
vi.mock("../components/divan/TriageLoop", () => ({
	TriageLoop: () => <div data-testid="loop-stub" />,
}));
vi.mock("../components/divan/DecisionFeed", () => ({
	DecisionFeed: () => <div data-testid="decisions-stub" />,
}));
vi.mock("../components/divan/CaylakDetail", () => ({
	CaylakDetail: () => <div data-testid="detail-stub" />,
}));

function LocationProbe() {
	return <span data-testid="live-path">{useLocation().pathname}</span>;
}

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<LocationProbe />
			<Routes>
				<Route path={DIVAN_PATH} element={<DivanPage />} />
				<Route path={DIVAN_RAPORLAR_PATH} element={<DivanPage section="raporlar" />} />
			</Routes>
		</MemoryRouter>,
	);
}

describe("the divan's raporlar URL", () => {
	it("mounts both mod panes for a moderator navigating straight to it, with no click", () => {
		isModerator = true;
		const {container} = renderAt(DIVAN_RAPORLAR_PATH);
		expect(container.querySelector(".kp-divan__raporlar-pane")).toBeTruthy();
		expect(container.querySelector(".kp-divan__decisions-pane")).toBeTruthy();
		expect(container.querySelector(".kp-divan__decisions-title")).toBeTruthy();
		expect(container.querySelector(".kp-divan__roster-pane")).toBeNull();
	});

	// The server's `isModerator` stays the gate — the path only names what was asked for.
	it("lands a non-moderator on the roster and shows neither mod pane", () => {
		isModerator = false;
		const {container} = renderAt(DIVAN_RAPORLAR_PATH);
		expect(container.querySelector(".kp-divan__roster-pane")).toBeTruthy();
		expect(container.querySelector(".kp-divan__raporlar-pane")).toBeNull();
		expect(container.querySelector(".kp-divan__decisions-pane")).toBeNull();
		expect(container.querySelector(".kp-divan__nav")).toBeNull();
	});

	it("keeps the bare /divan URL on the roster for a moderator", () => {
		isModerator = true;
		const {container} = renderAt(DIVAN_PATH);
		expect(container.querySelector(".kp-divan__roster-pane")).toBeTruthy();
		expect(container.querySelector(".kp-divan__raporlar-pane")).toBeNull();
	});

	// The URL moving is what makes a reload and a shared link land back on the same pane; the
	// direct-navigation test above is the other half of that round trip.
	it("moves the URL when the in-page nav is clicked", () => {
		isModerator = true;
		const {container} = renderAt(DIVAN_PATH);
		expect(screen.getByTestId("live-path").textContent).toBe(DIVAN_PATH);

		fireEvent.click(screen.getByTestId("divan-nav-raporlar"));
		expect(screen.getByTestId("live-path").textContent).toBe(DIVAN_RAPORLAR_PATH);
		expect(container.querySelector(".kp-divan__raporlar-pane")).toBeTruthy();

		fireEvent.click(screen.getByTestId("divan-nav-caylaklar"));
		expect(screen.getByTestId("live-path").textContent).toBe(DIVAN_PATH);
		expect(container.querySelector(".kp-divan__roster-pane")).toBeTruthy();
	});
});
