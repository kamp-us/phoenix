/**
 * The auth entry surfaces in English (#7528). Kept beside `AuthPage.test.tsx` rather than folded
 * into it: that file pins the #1888 signup→setUsername race, this one pins the locale seam.
 *
 * The locale is seeded in storage before mount, which is what a returning English reader hands
 * the provider; `en` then arrives over `catalog.ts`'s dynamic import, so every assertion waits.
 */
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {FateClient} from "react-fate";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {installFakeStorage} from "../../tests/client/fakeStorage";
import {LocaleProvider} from "../i18n";
import {LOCALE_STORAGE_KEY} from "../lib/localeStorage";
import {AuthPage} from "./AuthPage";
import {UsernameBootstrap} from "./UsernameBootstrap";

vi.mock("../auth/client", () => ({
	authClient: {
		signUp: {email: vi.fn(async () => ({error: null}))},
		signIn: {email: vi.fn(async () => ({error: null}))},
	},
}));

function mount(children: ReactNode) {
	const client = {mutations: {user: {setUsername: vi.fn(async () => ({error: null}))}}};
	return render(
		<FateClient client={client as never}>
			<LocaleProvider>{children}</LocaleProvider>
		</FateClient>,
	);
}

beforeEach(() => {
	installFakeStorage({[LOCALE_STORAGE_KEY]: "en"});
});

describe("AuthPage in English", () => {
	it("renders the sign-in form in English", async () => {
		mount(<AuthPage />);
		await waitFor(() => expect(screen.getByText("sign in")).toBeTruthy());
		expect(screen.getByText("pick up where you left off.")).toBeTruthy();
		expect(screen.getByLabelText("e-mail")).toBeTruthy();
		expect(screen.getByLabelText("password")).toBeTruthy();
		expect(screen.getByRole("button", {name: "continue"})).toBeTruthy();
	});

	it("renders the sign-up form in English and keeps the brand nouns Turkish", async () => {
		mount(<AuthPage />);
		await waitFor(() => expect(screen.getByRole("button", {name: "sign up"})).toBeTruthy());
		fireEvent.click(screen.getByRole("button", {name: "sign up"}));

		expect(screen.getByLabelText("display name")).toBeTruthy();
		expect(screen.getByRole("button", {name: "create account"})).toBeTruthy();
		// Brand nouns read the same in either interface (ADR 0347), and `divan` arrives through
		// the interpolated placeholder rather than being spelled into the English message.
		const rite = screen.getByText(/reviewed as a çaylak/);
		expect(rite.textContent).toContain("in the divan");
		expect(rite.textContent).toContain("a yazar vouches for you");
	});

	it("speaks English in the hand-rolled field validation, which is all a noValidate form has", async () => {
		mount(<AuthPage />);
		await waitFor(() => expect(screen.getByRole("button", {name: "continue"})).toBeTruthy());
		fireEvent.submit(screen.getByRole("button", {name: "continue"}).closest("form")!);
		await waitFor(() => expect(screen.getByText("e-mail is required")).toBeTruthy());
	});
});

describe("UsernameBootstrap in English", () => {
	it("renders the confirm step in English", async () => {
		mount(<UsernameBootstrap email="elif@kamp.us" onComplete={vi.fn()} />);
		await waitFor(() => expect(screen.getByText("choose your username")).toBeTruthy());
		expect(screen.getByLabelText("username")).toBeTruthy();
		expect(screen.getByRole("button", {name: "confirm this name"})).toBeTruthy();
	});
});
