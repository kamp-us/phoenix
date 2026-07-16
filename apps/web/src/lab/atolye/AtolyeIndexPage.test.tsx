/**
 * The /lab/atölye index lists exactly what the headless registry enumerates and deep-links each
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
		<MemoryRouter initialEntries={["/lab/atölye"]}>
			<AtolyeIndexPage />
		</MemoryRouter>,
	);
}

describe("AtolyeIndexPage — /lab/atölye index (#3092)", () => {
	it("renders one row per registered exhibit, sourced from listExhibits()", () => {
		renderPage();
		const list = screen.getByRole("list", {name: "sergiler"});
		expect(within(list).getAllByRole("listitem")).toHaveLength(listExhibits().length);
	});

	it("links each exhibit to its /lab/atölye/:exhibit detail path", () => {
		renderPage();
		for (const exhibit of listExhibits()) {
			const link = screen.getByRole("link", {name: new RegExp(exhibit.title)});
			// `\S*` tolerates whether react-router keeps the `ö` literal or percent-encodes it in
			// the href attribute; the load-bearing assertion is the deep-link's exhibit-id segment.
			expect(link.getAttribute("href")).toMatch(new RegExp(`/lab/at\\S*/${exhibit.id}$`));
		}
	});
});
