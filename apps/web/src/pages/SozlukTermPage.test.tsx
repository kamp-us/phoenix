import {render, screen, waitFor} from "@testing-library/react";
import type {ViewRef} from "react-fate";
import {MemoryRouter} from "react-router";
import {describe, expect, it, vi} from "vitest";
import {LocaleProvider} from "../i18n";
import {LOCALE_STORAGE_KEY} from "../lib/localeStorage";
import {DefinitionsList, NewTermComposer} from "./SozlukTermPage";

vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	return {
		...actual,
		useFateClient: () => ({request: vi.fn(), store: {}}),
		useView: () => ({definitions: {}}),
		useLiveListView: () => [[], null],
	};
});

vi.mock("../fate/useReadbackRefetch", () => ({
	useReadbackRefetch: () => vi.fn(),
	useConfirmGone: () => vi.fn(),
}));

// Composer leaf deps, stubbed so the signed-in branch mounts without its full wiring.
vi.mock("../flags/useFlag", () => ({useFlag: () => ({value: false, loading: false})}));
vi.mock("../components/authorship/FirstContributionOnramp", () => ({
	FirstContributionOnramp: () => null,
}));
vi.mock("../fate/useDraftSubmit", () => ({
	useDraftSubmit: () => ({error: null, setError: vi.fn(), inFlight: false, run: vi.fn()}),
}));
vi.mock("../lib/useDraftAutosave", () => ({
	useDraftAutosave: () => ({offered: null, accept: vi.fn(), dismiss: vi.fn(), clear: vi.fn()}),
}));

const sessionMock = vi.hoisted(() => ({data: null as {user: unknown} | null}));
vi.mock("../auth/client", () => ({useSession: () => sessionMock}));

function renderList() {
	render(
		<MemoryRouter>
			<DefinitionsList term={{} as ViewRef<"Term">} slug="foo-bar" seedDefinitionId={null} />
		</MemoryRouter>,
	);
}

function renderListInEnglish() {
	window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
	render(
		<MemoryRouter>
			<LocaleProvider>
				<DefinitionsList term={{} as ViewRef<"Term">} slug="foo-bar" seedDefinitionId={null} />
			</LocaleProvider>
		</MemoryRouter>,
	);
}

describe("DefinitionsList anon affordance (#2211)", () => {
	it("logged-out: shows a sign-in prompt, not the live composer", () => {
		sessionMock.data = null;
		renderList();
		expect(screen.queryByTestId("sozluk-composer-submit")).toBeNull();
		const prompt = screen.getByTestId("sozluk-composer-signin");
		const link = prompt.querySelector("a");
		expect(link?.getAttribute("href")).toBe("/auth?returnTo=%2Fsozluk%2Ffoo-bar");
	});

	it("signed-in: renders the live composer, no sign-in prompt", () => {
		sessionMock.data = {user: {id: "u1", name: "yazar"}};
		renderList();
		expect(screen.queryByTestId("sozluk-composer-signin")).toBeNull();
		expect(screen.getByTestId("sozluk-composer-submit")).not.toBeNull();
	});
});

describe("the term page's composer reads English at locale en (#7529)", () => {
	it("logged-out: the sign-in prompt and its link are English", async () => {
		sessionMock.data = null;
		renderListInEnglish();
		await waitFor(() =>
			expect(screen.getByTestId("sozluk-composer-signin").textContent).toContain(
				"to add an entry,",
			),
		);
		expect(screen.getByRole("link", {name: "sign in"})).not.toBeNull();
		expect(screen.getByText("how would you define it?")).toBeTruthy();
	});

	it("signed-in: the composer's label, placeholder and submit are English", async () => {
		sessionMock.data = {user: {id: "u1", name: "yazar"}};
		renderListInEnglish();
		await waitFor(() => expect(screen.getByLabelText("entry")).toBeTruthy());
		expect(screen.getByTestId("sozluk-composer-submit").textContent).toBe("add entry");
		expect(screen.getByText("markdown ·", {exact: false})).toBeTruthy();
	});
});

// The undefined slug has no stored `first_letter`, so the letter comes off the slug — through
// `sozlukLetterOf`, the fold the column's own producers share. `slug.charAt(0).toLowerCase()`
// read `IŞIK` as `i` while the same headword reads `ı` everywhere else (#9602).
describe("NewTermComposer's breadcrumb letter", () => {
	function renderComposer(slug: string) {
		sessionMock.data = {user: {id: "u1", name: "yazar"}};
		const {container} = render(
			<MemoryRouter>
				<NewTermComposer slug={slug} onCreated={vi.fn()} />
			</MemoryRouter>,
		);
		return container.querySelector(".kp-sozluk-term__crumbs") as HTMLElement;
	}

	function letterCrumb(slug: string, letter: string): string | null {
		renderComposer(slug);
		return screen.queryByRole("link", {name: letter})?.getAttribute("href") ?? null;
	}

	it("folds the dotless capital I to ı, not to i", () => {
		expect(letterCrumb("IŞIK", "ı")).toBe(`/sozluk/harf/${encodeURIComponent("ı")}`);
		expect(screen.queryByRole("link", {name: "i"})).toBeNull();
	});

	it("keeps a slug already starting ı on the dotless letter's page", () => {
		expect(letterCrumb("ışık", "ı")).toBe(`/sozluk/harf/${encodeURIComponent("ı")}`);
	});

	it("folds the dotted capital İ to i", () => {
		expect(letterCrumb("İMECE", "i")).toBe("/sozluk/harf/i");
	});

	it("keeps a slug already starting i on the dotted letter's page", () => {
		expect(letterCrumb("imece", "i")).toBe("/sozluk/harf/i");
	});

	it("renders no letter crumb for a slug the alphabet does not index", () => {
		const crumbs = renderComposer("3-adim");
		expect(crumbs.textContent).toContain("3 adim");
		expect(crumbs.querySelectorAll("a").length).toBe(1);
	});

	it("routes both crumbs through the router, so a click does not reload the page", () => {
		const crumbs = renderComposer("imece");
		const hrefs = [...crumbs.querySelectorAll("a")].map((a) => a.getAttribute("href"));
		expect(hrefs).toEqual(["/sozluk", "/sozluk/harf/i"]);
	});
});
