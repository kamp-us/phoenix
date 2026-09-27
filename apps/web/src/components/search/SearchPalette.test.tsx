/**
 * The ⌘K palette's product wiring (ADR 0186): the trigger and the shortcut open ONE surface,
 * a result row navigates to the thing it names, and the trailing row falls through to the
 * results page. The result READ is stubbed here — this file is about what the palette does
 * with results, not about how fate fetches them.
 */
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {MemoryRouter, useLocation} from "react-router";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {installFakeStorage} from "../../../tests/client/fakeStorage";
import {Topbar} from "../layout/Topbar";
import {SearchPalette} from "./SearchPalette";
import {SearchPaletteProvider, useSearchPalette} from "./SearchPaletteState";
import {SEARCH_HISTORY_STORAGE_KEY} from "./searchHistory";
import type {SearchPostResult, SearchResults, SearchTermResult} from "./useSearchResults";

let results: SearchResults = {status: "idle"};

const term = (row: {slug: string; title: string}): SearchTermResult => ({
	id: `term-${row.slug}`,
	slug: row.slug,
	title: row.title,
	definitionCount: 3,
});

const post = (row: {slug: string; title: string}): SearchPostResult => ({
	id: `post-${row.slug}`,
	slug: row.slug,
	title: row.title,
	host: "effect.website",
	commentCount: 2,
});

const ok = ({
	terms = [],
	posts = [],
}: {
	terms?: readonly SearchTermResult[];
	posts?: readonly SearchPostResult[];
}): SearchResults => ({status: "ok", terms, posts});

vi.mock("./useSearchResults", async (importOriginal) => {
	const original = await importOriginal<typeof import("./useSearchResults")>();
	return {...original, useSearchResults: () => results};
});

function Here() {
	const location = useLocation();
	return <div data-testid="here">{`${location.pathname}${location.search}`}</div>;
}

function renderShell() {
	return render(
		<MemoryRouter>
			<SearchPaletteProvider>
				<Topbar nav={[]} onSearchOpen={() => undefined} />
				<SearchPalette />
				<Here />
			</SearchPaletteProvider>
		</MemoryRouter>,
	);
}

/** The shell's real opener, wired the way `App` wires it. */
function renderApp() {
	function Shell() {
		return (
			<>
				<TopbarWithOpener />
				<SearchPalette />
				<Here />
			</>
		);
	}
	return render(
		<MemoryRouter>
			<SearchPaletteProvider>
				<Shell />
			</SearchPaletteProvider>
		</MemoryRouter>,
	);
}

function TopbarWithOpener() {
	const {setOpen} = useSearchPalette();
	return <Topbar nav={[]} onSearchOpen={() => setOpen(true)} />;
}

const query = async (value: string) => {
	const field = await screen.findByRole("combobox");
	fireEvent.change(field, {target: {value}});
	return field;
};

describe("⌘K palette wiring (ADR 0186)", () => {
	beforeEach(() => {
		results = {status: "idle"};
		installFakeStorage();
	});

	it("stays closed until the shell opens it — no second search surface renders on its own", () => {
		renderShell();
		expect(screen.queryByRole("combobox")).toBeNull();
	});

	it("the topbar trigger opens the one palette", async () => {
		renderApp();
		fireEvent.click(screen.getByRole("button", {name: "Ara"}));
		expect(await screen.findByRole("combobox")).toBeTruthy();
	});

	it("⌘K opens it too, and the browser's own binding is refused", async () => {
		renderApp();
		const event = new KeyboardEvent("keydown", {key: "k", metaKey: true, cancelable: true});
		document.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(await screen.findByRole("combobox")).toBeTruthy();
	});

	it.each([
		["sözlük", "/sozluk", 0],
		["pano", "/pano", 1],
		["profilin", "/profile", 2],
	])("the empty frame opens the %s shortcut with Enter", async (_label, destination, moves) => {
		renderApp();
		fireEvent.click(screen.getByRole("button", {name: "Ara"}));
		const field = await screen.findByRole("combobox");
		expect(screen.getAllByRole("option")).toHaveLength(3);
		for (let move = 0; move < moves; move += 1) fireEvent.keyDown(field, {key: "ArrowDown"});
		fireEvent.keyDown(field, {key: "Enter"});
		expect(screen.getByTestId("here").textContent).toBe(destination);
	});

	it("selecting a sözlük row navigates to that term", async () => {
		results = ok({terms: [term({slug: "yatay-olcekleme", title: "yatay ölçekleme"})]});
		renderApp();
		fireEvent.click(screen.getByRole("button", {name: "Ara"}));
		await query("yatay");
		fireEvent.pointerDown(screen.getByRole("option", {name: /yatay ölçekleme/}));
		expect(screen.getByTestId("here").textContent).toBe("/sozluk/yatay-olcekleme");
	});

	it("selecting a pano row navigates to that post", async () => {
		results = ok({posts: [post({slug: "effect-ts", title: "Effect nedir"})]});
		renderApp();
		fireEvent.click(screen.getByRole("button", {name: "Ara"}));
		await query("effect");
		fireEvent.pointerDown(screen.getByRole("option", {name: /Effect nedir/}));
		expect(screen.getByTestId("here").textContent).toBe("/pano/effect-ts");
	});

	it("offers the results page for the same query — the palette is a first page, not the whole search", async () => {
		results = ok({});
		renderApp();
		fireEvent.click(screen.getByRole("button", {name: "Ara"}));
		await query("react");
		fireEvent.pointerDown(screen.getByRole("option", {name: /tüm sonuçlar/}));
		expect(screen.getByTestId("here").textContent).toBe("/search?q=react");
	});

	it("a query below the backend's minimum offers no results page and says why", async () => {
		results = {status: "idle"};
		renderApp();
		fireEvent.click(screen.getByRole("button", {name: "Ara"}));
		await query("a");
		expect(screen.queryByRole("option")).toBeNull();
		expect(screen.getByRole("status").textContent).toContain("en az 2 harf");
	});

	it("shows only search rows once the query reaches the backend minimum", async () => {
		results = ok({terms: [term({slug: "react", title: "React"})]});
		renderApp();
		fireEvent.click(screen.getByRole("button", {name: "Ara"}));
		await query("re");
		expect(screen.getByRole("option", {name: /React/})).toBeTruthy();
		expect(screen.getByRole("option", {name: /tüm sonuçlar/})).toBeTruthy();
		expect(screen.queryByRole("option", {name: "profilin"})).toBeNull();
	});

	it("remembers a submitted query and selecting it searches again without navigating", async () => {
		results = ok({posts: [post({slug: "effect-ts", title: "Effect nedir"})]});
		renderApp();
		fireEvent.click(screen.getByRole("button", {name: "Ara"}));
		await query("effect");
		fireEvent.pointerDown(screen.getByRole("option", {name: /Effect nedir/}));
		expect(screen.getByTestId("here").textContent).toBe("/pano/effect-ts");
		expect(JSON.parse(localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY) ?? "null")).toEqual([
			"effect",
		]);

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(screen.getByRole("button", {name: "Ara"}));
		const recent = await screen.findByRole("option", {name: /effect yeniden ara/});
		fireEvent.pointerDown(recent);
		expect(screen.getByRole<HTMLInputElement>("combobox").value).toBe("effect");
		expect(screen.getByTestId("here").textContent).toBe("/pano/effect-ts");
	});

	it("falls back to the three shortcuts when storage refuses reads", async () => {
		const refusing: Storage = {
			...installFakeStorage(),
			getItem: () => {
				throw new Error("blocked");
			},
		};
		Object.defineProperty(window, "localStorage", {value: refusing, configurable: true});
		renderApp();
		fireEvent.click(screen.getByRole("button", {name: "Ara"}));
		expect(await screen.findAllByRole("option")).toHaveLength(3);
	});
});
