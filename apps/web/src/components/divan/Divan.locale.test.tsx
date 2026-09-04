/**
 * The divan's two mod surfaces render English once the reader picks `en` (#7532). The brand
 * nouns stay put across the swap, which is the half a catalog-key test cannot show.
 */
import {render, screen, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {LocaleProvider} from "../../i18n";
import {LOCALE_STORAGE_KEY} from "../../lib/localeStorage";
import {DivanRoster} from "./DivanRoster";
import {Raporlar} from "./Raporlar";

let listItems: ReadonlyArray<{node: {id: string}}>;
let viewData: unknown;

vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	return {
		...actual,
		useRequest: () => ({"divan.roster": "conn", "report.listOpen": "conn"}),
		useListView: () => [listItems, null, null],
		useView: () => viewData,
	};
});

const ROSTER_ROW = {
	authorId: "a-1",
	displayName: null,
	username: null,
	totalKarma: 12,
	viewerVouched: false,
	totalCount: 3,
	definitionCount: 1,
	postCount: 1,
	commentCount: 1,
};

const REPORT_ROW = {
	id: "r-1",
	targetKind: "post" as const,
	targetId: "p-1",
	reportCount: 2,
	reason: null,
	firstReportedAt: Date.now(),
	targetExcerpt: null,
	targetAuthor: null,
	targetRef: null,
};

beforeEach(() => {
	window.localStorage.clear();
	window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
});

describe("the divan renders English for an `en` reader", () => {
	it("swaps the roster's copy and holds çaylak, the brand noun", async () => {
		listItems = [{node: {id: "n-1"}}];
		viewData = ROSTER_ROW;
		render(
			<LocaleProvider>
				<DivanRoster selectedId={null} onSelect={() => {}} />
			</LocaleProvider>,
		);

		await waitFor(() =>
			expect(screen.getByRole("list").getAttribute("aria-label")).toBe("çaylaklar under review"),
		);
		expect(screen.getByText("3 items · 1 definition, 1 post, 1 comment")).toBeTruthy();
		expect(screen.getByTestId("divan-caylak-a-1").textContent).toContain("çaylak");
	});

	// Each count in the roster line inflects on its own value, so a row mixing 1, 0 and 2 is
	// what catches a frame pluralized on one count for all four.
	it("inflects every count in the roster line on its own value", async () => {
		listItems = [{node: {id: "n-1"}}];
		viewData = {...ROSTER_ROW, totalCount: 1, definitionCount: 1, postCount: 0, commentCount: 2};
		render(
			<LocaleProvider>
				<DivanRoster selectedId={null} onSelect={() => {}} />
			</LocaleProvider>,
		);

		await waitFor(() =>
			expect(screen.getByText("1 item · 1 definition, 0 posts, 2 comments")).toBeTruthy(),
		);
	});

	it("swaps raporlar's copy", async () => {
		listItems = [{node: {id: "n-1"}}];
		viewData = REPORT_ROW;
		render(
			<LocaleProvider>
				<Raporlar />
			</LocaleProvider>,
		);

		await waitFor(() =>
			expect(screen.getByTestId("divan-raporlar").getAttribute("aria-label")).toBe("open reports"),
		);
		expect(screen.getByText("post")).toBeTruthy();
		expect(screen.getByText("2 reports")).toBeTruthy();
		expect(screen.getByText("no reason given")).toBeTruthy();
	});

	it("leaves the Turkish default alone when the reader picked nothing", async () => {
		window.localStorage.clear();
		listItems = [];
		render(
			<LocaleProvider>
				<DivanRoster selectedId={null} onSelect={() => {}} />
			</LocaleProvider>,
		);

		const empty = await screen.findByTestId("divan-roster-empty");
		expect(empty.textContent).toBe("incelemede bekleyen çaylak yok.");
	});
});
