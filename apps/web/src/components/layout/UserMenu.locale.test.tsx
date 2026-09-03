/**
 * The `dil` row's gate and the layout's English render (#7527). Kept beside `UserMenu.test.tsx`
 * rather than folded into it: that file pins CSS paint facts, this one pins the locale seam.
 */
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {MemoryRouter} from "react-router";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {PHOENIX_LOCALE} from "../../flags/keys";
import {LocaleProvider} from "../../i18n";
import {LOCALE_STORAGE_KEY} from "../../lib/localeStorage";
import {AppShell} from "./AppShell";
import {Subnav} from "./Subnav";
import {Topbar} from "./Topbar";
import {UserMenu} from "./UserMenu";

// `useFlag` resolves non-boot keys over `POST /api/flags/evaluate`; stubbing the response is
// what decides whether the gated row renders.
function stubFlag(on: boolean) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			on
				? new Response(JSON.stringify({flags: {[PHOENIX_LOCALE]: true}}), {
						headers: {"content-type": "application/json"},
					})
				: new Response("nope", {status: 500}),
		),
	);
}

function mountMenu(children?: ReactNode) {
	return render(
		<MemoryRouter>
			<LocaleProvider>
				{children}
				<UserMenu
					user={{name: "Elif", username: "elif"}}
					themeChoice="dark"
					onThemeChange={() => {}}
					onLogout={() => {}}
				/>
			</LocaleProvider>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	window.localStorage.clear();
	document.documentElement.lang = "";
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the dil row rides the phoenix-locale flag", () => {
	it("renders no dil row with the flag off, leaving the panel exactly as today", async () => {
		stubFlag(false);
		mountMenu();
		fireEvent.click(screen.getByText("Elif"));
		await screen.findByRole("button", {name: "çıkış"});
		expect(screen.getByTestId("topbar-theme-row")).toBeTruthy();
		expect(screen.queryByTestId("topbar-locale-row")).toBeNull();
	});

	it("renders the dil row with the flag on, labelled by its endonyms", async () => {
		stubFlag(true);
		mountMenu();
		fireEvent.click(screen.getByText("Elif"));
		const row = await screen.findByTestId("topbar-locale-row");
		expect(row.textContent).toContain("dil");
		expect(screen.getByRole("radio", {name: "Türkçe"}).getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("radio", {name: "English"})).toBeTruthy();
	});
});

describe("picking English renders the layout in English", () => {
	it("swaps the shell, the menu rows and the subnav, and holds the brand noun", async () => {
		stubFlag(true);
		mountMenu(
			<>
				<AppShell>
					<Topbar divanTo="/divan" />
				</AppShell>
				<Subnav crumb={{label: "etiket", onClear: () => {}}} />
			</>,
		);
		fireEvent.click(screen.getByText("Elif"));
		await screen.findByTestId("topbar-locale-row");

		expect(screen.getByText("içeriğe geç")).toBeTruthy();

		await act(async () => {
			fireEvent.click(screen.getByRole("radio", {name: "English"}));
		});

		await waitFor(() => expect(screen.getByText("skip to content")).toBeTruthy());
		expect(screen.getByRole("button", {name: "log out"})).toBeTruthy();
		expect(screen.getByTestId("topbar-profile-link").textContent).toBe("profile");
		expect(screen.getByPlaceholderText("search…")).toBeTruthy();
		expect(screen.getByText("× clear filter")).toBeTruthy();
		// divan is a brand noun — it reads the same in the English interface (ADR 0347).
		expect(screen.getByTestId("topbar-divan-link").getAttribute("aria-label")).toBe("divan");
		expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
		expect(document.documentElement.lang).toBe("en");
	});
});
