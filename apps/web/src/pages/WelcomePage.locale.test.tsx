/**
 * The welcome moment in English (#7528). Its own file because `WelcomePage.test.tsx` pins the
 * gate order, and because the mocks a locale render needs are the same ones a gate render does —
 * duplicating them here keeps that file's story about gating alone.
 */
import {render, screen, waitFor} from "@testing-library/react";
import {MemoryRouter, Route, Routes} from "react-router";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {installFakeStorage} from "../../tests/client/fakeStorage";
import {LocaleProvider} from "../i18n";
import {LOCALE_STORAGE_KEY} from "../lib/localeStorage";
import {WelcomePage} from "./WelcomePage";
import {WELCOME_PATH} from "./welcomeGating";

let tier = "çaylak";

vi.mock("../auth/client", () => ({
	useSession: () => ({data: {user: {id: "u-1"}}, isPending: false}),
}));
vi.mock("../auth/useMe", () => ({
	useMe: () => ({me: {id: "u-1", tier}, status: "ok", loading: false, refetch: vi.fn()}),
}));
vi.mock("../flags/useFlag", () => ({useFlag: () => ({value: true, loading: false})}));
vi.mock("../fate/useImperativeView", () => ({
	useImperativeView: () => ({
		state: {
			status: "ok",
			data: {id: "s-1", karma: 3, bar: 15, vouchExists: false, inReviewCount: 0},
		},
		refetch: vi.fn(),
	}),
}));

function mount() {
	return render(
		<MemoryRouter initialEntries={[`${WELCOME_PATH}?returnTo=${encodeURIComponent("/pano")}`]}>
			<LocaleProvider>
				<Routes>
					<Route path={WELCOME_PATH} element={<WelcomePage />} />
				</Routes>
			</LocaleProvider>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	installFakeStorage({[LOCALE_STORAGE_KEY]: "en"});
	tier = "çaylak";
});

describe("WelcomePage in English", () => {
	it("renders the çaylak welcome in English, brand nouns untranslated", async () => {
		mount();
		await waitFor(() =>
			expect(screen.getByTestId("welcome-title").textContent).toBe("welcome, çaylak"),
		);
		expect(screen.getByText("where you stand")).toBeTruthy();
		expect(screen.getByText("the road ahead")).toBeTruthy();
		expect(screen.getByRole("button", {name: "continue"})).toBeTruthy();
		expect(screen.getByText("your account is new; you are still a çaylak.")).toBeTruthy();
		// `kefil` is the dt of the vouch fact and reads the same in either interface.
		expect(screen.getByText("kefil")).toBeTruthy();
	});

	it("renders the yazar note in English", async () => {
		tier = "yazar";
		mount();
		await waitFor(() =>
			expect(screen.getByTestId("welcome-yazar-note").textContent).toBe(
				"you are already a yazar; what you write goes live directly.",
			),
		);
		expect(screen.getByTestId("welcome-title").textContent).toBe("welcome");
	});
});
