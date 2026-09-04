import {render, screen, waitFor} from "@testing-library/react";
import type {ViewRef} from "react-fate";
import {MemoryRouter} from "react-router";
import {describe, expect, it, vi} from "vitest";
import {LocaleProvider} from "../i18n";
import {LOCALE_STORAGE_KEY} from "../lib/localeStorage";
import {DefinitionsList} from "./SozlukTermPage";

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
