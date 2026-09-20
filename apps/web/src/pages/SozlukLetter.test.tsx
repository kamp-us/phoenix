/**
 * The letter route's own guard (#9267): a route value that names no indexed letter has no
 * page, so it goes home instead of rendering an index that is empty by construction. Only the
 * pre-fate half is exercised here — the list itself reads a connection, which the e2e walks.
 */
import {render, screen} from "@testing-library/react";
import {MemoryRouter, Route, Routes} from "react-router";
import {describe, expect, it} from "vitest";
import {SozlukLetter} from "./SozlukLetter";

function renderRoute(initial: string) {
	return render(
		<MemoryRouter initialEntries={[initial]}>
			<Routes>
				<Route path="/sozluk" element={<div data-testid="home">home</div>} />
				<Route path="/sozluk/harf/:letter" element={<SozlukLetter />} />
			</Routes>
		</MemoryRouter>,
	);
}

describe("SozlukLetter — the route guard", () => {
	it("sends a non-letter route value home rather than rendering an empty letter", () => {
		renderRoute("/sozluk/harf/3");
		expect(screen.getByTestId("home")).toBeTruthy();
	});

	it("sends a multi-character segment home too", () => {
		renderRoute("/sozluk/harf/abc");
		expect(screen.getByTestId("home")).toBeTruthy();
	});

	it("keeps a real letter on its own page — the masthead names it in Turkish capitals", () => {
		const {container} = renderRoute("/sozluk/harf/i");
		expect(screen.queryByTestId("home")).toBeNull();
		// `i` uppercases to `İ`, never the ASCII `I`.
		expect(container.querySelector(".kp-sozluk-letter__title")?.textContent).toBe("İ harfi");
	});

	it("normalises an uppercase route value to its own letter, Turkish-wise", () => {
		const {container} = renderRoute(`/sozluk/harf/${encodeURIComponent("I")}`);
		expect(container.querySelector(".kp-sozluk-letter__title")?.textContent).toBe("I harfi");
	});

	it("keeps q, w and x on their own pages, in either case (#9425)", () => {
		for (const [route, title] of [
			["q", "Q harfi"],
			["W", "W harfi"],
			["x", "X harfi"],
		] as const) {
			const {container, unmount} = renderRoute(`/sozluk/harf/${route}`);
			expect(screen.queryByTestId("home")).toBeNull();
			expect(container.querySelector(".kp-sozluk-letter__title")?.textContent).toBe(title);
			unmount();
		}
	});
});
