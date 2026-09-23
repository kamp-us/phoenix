/**
 * The term header's breadcrumb letter reads the STORED `first_letter`, not a fold of its own
 * (#9331). It used to run `title.charAt(0).toLowerCase()`, which is a fourth derivation of a
 * column three other places already derive — and wrong twice over for Turkish: ASCII lowercasing
 * maps `İ` to `i̇` and `I` to `i`, when `İ` is `i`'s capital and `I` is the dotless `ı`'s.
 */
import {render, screen, within} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it, vi} from "vitest";
import {LocaleProvider} from "../../i18n";
import {sozlukLetterHref} from "../../lib/sozlukLetterHref";
import {SozlukTermHeader} from "./SozlukTermHeader";

let viewData: unknown;

vi.mock("react-fate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-fate")>();
	return {...actual, useView: () => viewData};
});

const TERM = {
	id: "isik",
	slug: "isik",
	title: "ışık",
	count: 1,
	totalScore: 0,
	firstAt: null,
	lastEdit: null,
	firstLetter: "ı",
};

function renderHeader(term: unknown) {
	viewData = term;
	const {container} = render(
		<MemoryRouter>
			<LocaleProvider>
				<SozlukTermHeader term={"ref" as never} />
			</LocaleProvider>
		</MemoryRouter>,
	);
	return container.querySelector(".kp-sozluk-term__crumbs")?.textContent ?? "";
}

function letterCrumbHref(term: unknown, letter: string): string | null {
	renderHeader(term);
	return screen.queryByRole("link", {name: letter})?.getAttribute("href") ?? null;
}

describe("SozlukTermHeader — the breadcrumb letter", () => {
	it("shows the stored column, so the crumb and the row's letter are one value", () => {
		expect(renderHeader(TERM)).toContain("ı");
		expect(screen.getByRole("link", {name: "ı"})).toBeTruthy();
	});

	// `IŞIK` and `ışık` are one headword under one letter. The old ASCII fold read the capital
	// as `i` and split them across two.
	it("does not re-fold the title, so an uppercase headword keeps its own letter", () => {
		expect(renderHeader({...TERM, title: "IŞIK"})).toContain("ı");
		expect(screen.queryByRole("link", {name: "i"})).toBeNull();
	});

	// A headword outside the alphabet stores `""` and has no letter page, so naming one in the
	// crumb would link the reader at a page the route sends them home from.
	it("drops the letter crumb for a headword the alphabet does not index", () => {
		const crumbs = renderHeader({...TERM, title: "webhook", slug: "webhook", firstLetter: ""});
		expect(crumbs).toContain("webhook");
		expect(crumbs.split("/").length).toBe(2);
	});
});

// The crumb and the alphabet strip are two controls for one letter on one screen, so they share
// `sozlukLetterHref` — the crumb used to point at `/sozluk`, where the root crumb beside it already
// goes (#9355). `false` is right for every term page: a term page is never the letter's own page.
describe("SozlukTermHeader — where the letter crumb goes", () => {
	it("sends an ASCII letter to that letter's page", () => {
		expect(letterCrumbHref({...TERM, title: "imece", slug: "imece", firstLetter: "i"}, "i")).toBe(
			"/sozluk/harf/i",
		);
	});

	// `ı` and `i` are two letters, not one letter's two cases, so their pages are two URLs — and the
	// dotless one is non-ASCII, so it only survives the round trip percent-encoded.
	it("percent-encodes the dotless ı, keeping it off the dotted i's page", () => {
		expect(letterCrumbHref(TERM, "ı")).toBe(`/sozluk/harf/${encodeURIComponent("ı")}`);
		expect(encodeURIComponent("ı")).not.toBe("i");
	});

	it("percent-encodes ç the same way the alphabet strip does", () => {
		expect(letterCrumbHref({...TERM, title: "çeviri", slug: "ceviri", firstLetter: "ç"}, "ç")).toBe(
			sozlukLetterHref("ç", false),
		);
	});

	it("leaves the root crumb pointing at the sözlük home", () => {
		renderHeader(TERM);
		expect(screen.getByRole("link", {name: "sözlük"}).getAttribute("href")).toBe("/sozluk");
	});
});

/** Each crumb's text with its `aria-hidden` parts removed: what assistive tech reads per item. */
function spokenCrumbs(nav: HTMLElement): string[] {
	return within(nav)
		.getAllByRole("listitem")
		.map((item) => {
			const copy = item.cloneNode(true) as HTMLElement;
			for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
			return copy.textContent ?? "";
		});
}

// The WAI-ARIA breadcrumb pattern (#9629): a named landmark around an ordered list, the page's
// own crumb marked current, and the `/` separators kept out of what a screen reader reads.
describe("SozlukTermHeader — the breadcrumb's semantics", () => {
	it("is a navigation landmark named from the catalog, holding one list item per crumb", () => {
		renderHeader(TERM);
		const nav = screen.getByRole("navigation", {name: "sayfa yolu"});
		expect(within(nav).getByRole("list").tagName).toBe("OL");
		expect(within(nav).getAllByRole("listitem")).toHaveLength(3);
	});

	it("marks the term title, and only it, as the current page", () => {
		renderHeader(TERM);
		const nav = screen.getByRole("navigation", {name: "sayfa yolu"});
		const current = nav.querySelectorAll("[aria-current]");
		expect(current).toHaveLength(1);
		expect(current[0]?.getAttribute("aria-current")).toBe("page");
		expect(spokenCrumbs(nav).at(-1)).toBe("ışık");
		expect(within(nav).getAllByRole("listitem").at(-1)).toBe(current[0]);
	});

	it("hides the separators, so the row reads as the crumb labels only", () => {
		renderHeader(TERM);
		const nav = screen.getByRole("navigation", {name: "sayfa yolu"});
		expect(nav.textContent).toBe("sözlük / ı / ışık");
		expect(spokenCrumbs(nav)).toEqual(["sözlük", "ı", "ışık"]);
	});

	it("keeps the same shape when the headword has no letter crumb", () => {
		renderHeader({...TERM, title: "webhook", slug: "webhook", firstLetter: ""});
		const nav = screen.getByRole("navigation", {name: "sayfa yolu"});
		expect(spokenCrumbs(nav)).toEqual(["sözlük", "webhook"]);
		expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
	});
});
