import {render, screen, within} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {ExhibitStage} from "../ExhibitStage";
import {getExhibit} from "../registry";

// The exhibit exists so a reviewer can see every markdown block at once. A sample that quietly
// loses one still renders a plausible-looking stage, so the coverage is asserted rather than read.
describe("Markdown exhibit — the stage shows every block a reviewer has to see", () => {
	const exhibit = getExhibit("markdown");

	it("is registered under the markdown slug", () => {
		expect(exhibit).toBeDefined();
	});

	it("renders bold, a link, inline code, a table, a list and a fenced block", () => {
		const {container} = render(<ExhibitStage exhibit={exhibit!} />);
		const stage = screen.getByTestId("exhibit-stage");

		expect(within(stage).getByText("Kalın metin").tagName).toBe("STRONG");

		const link = within(stage).getByRole("link", {name: "bağlantı"});
		expect(link.getAttribute("href")).toBe("https://github.com/kamp-us/phoenix");

		const table = within(stage).getByRole("table");
		expect(within(table).getAllByRole("columnheader")).toHaveLength(3);

		expect(container.querySelectorAll(".kp-markdown ul > li").length).toBeGreaterThan(2);

		const fenced = container.querySelector(".kp-markdown pre > code");
		expect(fenced?.className).toContain("language-ts");

		// The inline `kod` span is a `<code>` that is not the fenced one.
		const inline = [...container.querySelectorAll(".kp-markdown code")].filter(
			(node) => node.parentElement?.tagName !== "PRE",
		);
		expect(inline.length).toBeGreaterThan(0);
	});
});
