/**
 * The sözlük + search surfaces rendered in `en` (#7529). Seeds the stored locale rather than
 * clicking the UserMenu's `dil` row, so this file pins the surface's copy and not the flag that
 * offers the choice — `UserMenu.locale.test.tsx` owns that seam.
 */
import {render, screen, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import type {ViewRef} from "react-fate";
import {MemoryRouter} from "react-router";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {LocaleProvider} from "../../i18n";
import {LOCALE_STORAGE_KEY} from "../../lib/localeStorage";
import {SearchPage} from "../../pages/SearchPage";
import {SozlukHome} from "../../pages/SozlukHome";
import {SozlukAlphabet, SozlukPopular, SozlukTermRow} from "./Sozluk";
import {SozlukTermHeader} from "./SozlukTermHeader";

// `Screen` needs a fate boundary; rendering its fallback is what mounts SozlukHome's chrome.
vi.mock("../../fate/Screen", () => ({
	Screen: ({fallback}: {fallback: ReactNode}) => fallback,
}));

vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	return {
		...actual,
		useView: () => ({title: "yazılım", count: 1, totalScore: 3, firstAt: null, lastEdit: null}),
	};
});

function renderInEnglish(node: ReactNode, route = "/") {
	window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
	return render(
		<MemoryRouter initialEntries={[route]}>
			<LocaleProvider>{node}</LocaleProvider>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	window.localStorage.clear();
});

describe("the sözlük surface reads English at locale en", () => {
	it("renders the home masthead and its loading line in English", async () => {
		renderInEnglish(<SozlukHome />);
		await waitFor(() => expect(screen.getByText("loading…")).toBeTruthy());
		// sözlük is a brand noun — the title reads the same in either interface (ADR 0347).
		expect(screen.getByRole("heading", {level: 1}).textContent).toContain("sözlük");
	});

	it("renders the term header's counted nouns in English, singular at one", async () => {
		// The ref is never dereferenced: `useView` is mocked above and returns the row outright.
		renderInEnglish(<SozlukTermHeader term={{} as ViewRef<"Term">} />);
		await waitFor(() => expect(screen.getByText("1 entry")).toBeTruthy());
		expect(screen.getByText("3 votes")).toBeTruthy();
	});

	it("renders the alphabet's accessible names in English, keeping the Turkish letters", async () => {
		renderInEnglish(<SozlukAlphabet value="a" emptyLetters={["z"]} />);
		await waitFor(() => expect(screen.getByLabelText("letter A")).toBeTruthy());
		expect(screen.getByRole("navigation").getAttribute("aria-label")).toBe("Letter");
		// The index spans the Turkish alphabet in either locale: it addresses Turkish terms.
		expect(screen.getByLabelText("letter Ç")).toBeTruthy();
		expect(screen.getByText("(letter Z, no terms)")).toBeTruthy();
	});

	it("pluralises a term row's entry count by the English rule", async () => {
		renderInEnglish(
			<>
				<SozlukTermRow term={{slug: "a", title: "a", count: 1}} />
				<SozlukTermRow term={{slug: "b", title: "b", count: 4}} />
				<SozlukPopular terms={[{slug: "c", title: "c", totalScore: 1}]} />
			</>,
		);
		await waitFor(() => expect(screen.getByText("1 entry")).toBeTruthy());
		expect(screen.getByText("4 entries")).toBeTruthy();
		expect(screen.getByText("1 vote")).toBeTruthy();
	});

	it("renders the search page's prompt and masthead in English", async () => {
		renderInEnglish(<SearchPage />, "/ara?q=a");
		await waitFor(() =>
			expect(screen.getByText("enter at least 2 letters to search.")).toBeTruthy(),
		);
		expect(screen.getByRole("heading", {level: 1}).textContent).toContain("search");
	});
});
