/**
 * `/caylak-gorunurlugu` route contract (#6426, epic #4306). Four facts that each lose silently
 * if the gate order is "simplified": the dark route 404s, the resolving flag shows a neutral
 * placeholder instead of flashing that 404, a signed-out visitor leaves with a `returnTo`, and
 * a signed-in çaylak is told plainly why there is nothing to flip — with no switch on screen.
 */
import {render, screen} from "@testing-library/react";
import {MemoryRouter, Route, Routes, useLocation} from "react-router";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {CAYLAK_VISIBILITY_PATH, CaylakVisibilityPage} from "./CaylakVisibilityPage";

const flag = {value: false, loading: false};
let signedIn = true;
let sessionPending = false;
let tier: string | null = "yazar";

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
// The toggle's own read + write are pinned by `CaylakVisibilityToggle.test.tsx`; here it only
// has to be distinguishable from the çaylak note, so it renders inert with no transport.
vi.mock("../components/caylak-visibility/CaylakVisibilityToggle", () => ({
	CaylakVisibilitySetting: () => <div data-testid="caylak-visibility-toggle" />,
}));

function AuthProbe() {
	const location = useLocation();
	return <div data-testid="auth-page">{`${location.pathname}${location.search}`}</div>;
}

function renderRoute() {
	return render(
		<MemoryRouter initialEntries={[CAYLAK_VISIBILITY_PATH]}>
			<Routes>
				<Route path={CAYLAK_VISIBILITY_PATH} element={<CaylakVisibilityPage />} />
				<Route path="/auth" element={<AuthProbe />} />
			</Routes>
		</MemoryRouter>,
	);
}

describe("CaylakVisibilityPage (#6426)", () => {
	beforeEach(() => {
		flag.value = false;
		flag.loading = false;
		signedIn = true;
		sessionPending = false;
		tier = "yazar";
	});

	it("self-404s with phoenix-caylak-visibility off", () => {
		renderRoute();
		expect(screen.getByTestId("not-found-page")).toBeTruthy();
		expect(screen.queryByTestId("caylak-visibility-page")).toBeNull();
	});

	it("shows a neutral placeholder while the flag resolves — no 404 flash", () => {
		// The unresolved flag still reads its off default, so a gate that checked `flagOn`
		// before `flagLoading` would paint the 404 here and swap it out a tick later.
		flag.loading = true;
		renderRoute();
		expect(screen.getByTestId("caylak-visibility-loading")).toBeTruthy();
		expect(screen.queryByTestId("not-found-page")).toBeNull();
	});

	it("redirects a signed-out visitor to auth carrying a returnTo back here", () => {
		flag.value = true;
		signedIn = false;
		tier = null;
		renderRoute();
		expect(screen.getByTestId("auth-page").textContent).toBe(
			`/auth?returnTo=${encodeURIComponent(CAYLAK_VISIBILITY_PATH)}`,
		);
	});

	it("gives a signed-in çaylak a plain explanation and no toggle control", () => {
		flag.value = true;
		tier = "çaylak";
		renderRoute();
		const note = screen.getByTestId("caylak-visibility-caylak-note");
		expect(note.textContent).toContain("yazarlara özel");
		expect(screen.queryByTestId("caylak-visibility-toggle")).toBeNull();
	});

	it("gives a signed-in yazar the toggle", () => {
		flag.value = true;
		renderRoute();
		expect(screen.getByTestId("caylak-visibility-toggle")).toBeTruthy();
		expect(screen.queryByTestId("caylak-visibility-caylak-note")).toBeNull();
	});
});
