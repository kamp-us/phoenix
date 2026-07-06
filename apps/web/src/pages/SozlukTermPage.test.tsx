/**
 * Anon-affordance regression for the existing-term definition composer (#2211): a
 * logged-out visitor must see a sign-in prompt, never the live composer they can't
 * submit — matching the sözlük new-term branch and pano. The fate read hooks are
 * spied (the composer never mounts on the signed-out path, so its own deep wiring
 * is out of scope); the gate is driven purely by the mocked session.
 */
import {render, screen} from "@testing-library/react";
import type {ViewRef} from "react-fate";
import {MemoryRouter} from "react-router";
import {describe, expect, it, vi} from "vitest";
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

// Composer leaf deps — stubbed so the signed-in branch mounts the composer without
// its full fate/flag/draft wiring (the gate, not the composer internals, is under test).
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
