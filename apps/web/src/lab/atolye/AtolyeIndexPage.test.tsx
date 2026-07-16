/**
 * The /lab/atolye index lists exactly what the headless registry enumerates and deep-links each
 * row to its detail route (#3092). The registry is the seam: the page holds no exhibit list of its
 * own, so it can never drift from `listExhibits()`.
 */
import {render, screen, within} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it} from "vitest";
import {AtolyeIndexPage} from "./AtolyeIndexPage";
import {listExhibits} from "./registry";

function renderPage() {
	return render(
		<MemoryRouter initialEntries={["/lab/atolye"]}>
			<AtolyeIndexPage />
		</MemoryRouter>,
	);
}

describe("AtolyeIndexPage — /lab/atolye index (#3092)", () => {
	it("renders one row per registered exhibit, sourced from listExhibits()", () => {
		renderPage();
		const list = screen.getByRole("list", {name: "sergiler"});
		expect(within(list).getAllByRole("listitem")).toHaveLength(listExhibits().length);
	});

	it("links each exhibit to its ASCII /lab/atolye/:exhibit detail path", () => {
		renderPage();
		// Resolve each row by its unique detail href, not by a title regex: a link's
		// accessible name is title+summary, so real Turkish titles that share a word
		// (`Düğme` inside `Bildir Düğmesi`) would multi-match a name regex.
		const hrefs = screen.getAllByRole("link").map((l) => l.getAttribute("href"));
		for (const exhibit of listExhibits()) {
			expect(hrefs).toContain(`/lab/atolye/${exhibit.id}`);
		}
	});
});
