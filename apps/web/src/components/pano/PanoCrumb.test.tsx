/**
 * The pano site-filter crumb as a WAI-ARIA breadcrumb (#9629): the host is the current page, the
 * `/` separators stay out of the accessibility tree, and the clear link is not a crumb.
 */
import {render, screen, within} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it} from "vitest";
import {LocaleProvider} from "../../i18n";
import {PanoCrumb} from "./PanoCrumb";

function renderCrumb() {
	render(
		<MemoryRouter>
			<LocaleProvider>
				<PanoCrumb host="example.com" />
			</LocaleProvider>
		</MemoryRouter>,
	);
	return screen.getByRole("navigation", {name: "sayfa yolu"});
}

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

describe("PanoCrumb — the breadcrumb's semantics", () => {
	it("is a navigation landmark holding an ordered list of the three crumbs", () => {
		const nav = renderCrumb();
		expect(within(nav).getByRole("list").tagName).toBe("OL");
		expect(spokenCrumbs(nav)).toEqual(["pano", "site", "example.com"]);
	});

	it("marks the host crumb, and only it, as the current page", () => {
		const nav = renderCrumb();
		const current = nav.querySelectorAll("[aria-current]");
		expect(current).toHaveLength(1);
		expect(current[0]?.getAttribute("aria-current")).toBe("page");
		expect(within(nav).getAllByRole("listitem").at(-1)).toBe(current[0]);
	});

	it("hides the separators from assistive tech", () => {
		const nav = renderCrumb();
		expect(nav.textContent).toBe("pano / site / example.com");
		for (const sep of nav.querySelectorAll(".kp-breadcrumbs__sep")) {
			expect(sep.getAttribute("aria-hidden")).toBe("true");
		}
	});

	it("keeps the clear link outside the ordered list", () => {
		const nav = renderCrumb();
		const clear = screen.getByRole("link", {name: "× filtreyi kaldır"});
		expect(clear.getAttribute("href")).toBe("/pano");
		expect(nav.contains(clear)).toBe(false);
	});
});
