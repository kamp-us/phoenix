import {render, screen} from "@testing-library/react";
import {MemoryRouter} from "react-router";
import {describe, expect, it} from "vitest";
import {SearchPaletteExhibitDemo} from "./SearchPalette.exhibit";

const renderExhibit = (history: "empty" | "recent") =>
	render(
		<MemoryRouter>
			<SearchPaletteExhibitDemo history={history} />
		</MemoryRouter>,
	);

describe("SearchPalette exhibit", () => {
	it("renders the real zero-query destinations", async () => {
		renderExhibit("empty");
		expect(await screen.findByRole("option", {name: "sözlük"})).toBeTruthy();
		expect(screen.getByRole("option", {name: "pano"})).toBeTruthy();
		expect(screen.getByRole("option", {name: "profilin"})).toBeTruthy();
	});

	it("renders recent searches in place of the destinations", async () => {
		renderExhibit("recent");
		expect(await screen.findByRole("option", {name: /effect yeniden ara/})).toBeTruthy();
		expect(screen.getByRole("option", {name: /react yeniden ara/})).toBeTruthy();
		expect(screen.queryByRole("option", {name: "sözlük"})).toBeNull();
	});
});
