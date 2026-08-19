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
		const list = screen.getByRole("list", {name: "exhibits"});
		expect(within(list).getAllByRole("listitem")).toHaveLength(listExhibits().length);
	});

	it("links each exhibit to its ASCII /lab/atolye/:exhibit detail path", () => {
		renderPage();
		// Resolve each row by its unique detail href, not by a title regex: a link's
		// accessible name is title+summary, so component names that share a token
		// (`Button` inside `CopyLinkButton`) would multi-match a name regex.
		const hrefs = screen.getAllByRole("link").map((l) => l.getAttribute("href"));
		for (const exhibit of listExhibits()) {
			expect(hrefs).toContain(`/lab/atolye/${exhibit.id}`);
		}
	});
});
