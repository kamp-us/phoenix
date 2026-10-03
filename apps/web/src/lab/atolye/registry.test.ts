import {describe, expect, it} from "vitest";
import {getExhibit, listExhibits} from "./registry";

describe("exhibit registry — headless enumeration", () => {
	it("registers the Button exhibit with a component and a knob schema", () => {
		const button = getExhibit("button");
		expect(button).toBeDefined();
		expect(button?.title).toBe("Button");
		expect(button?.component).toBeTruthy();
		expect(Object.keys(button?.knobs ?? {})).toContain("variant");
	});

	it("registers the command palette with its search-state knobs", () => {
		const palette = getExhibit("command-palette");
		expect(palette?.title).toBe("Command Palette");
		expect(palette?.component).toBeTruthy();
		expect(Object.keys(palette?.knobs ?? {})).toEqual(
			expect.arrayContaining(["defaultQuery", "loading", "disabled", "maxResults"]),
		);
	});

	it("registers the product search palette with its history-state knob", () => {
		const palette = getExhibit("search-palette");
		expect(palette?.title).toBe("Search Palette");
		expect(palette?.component).toBeTruthy();
		expect(Object.keys(palette?.knobs ?? {})).toContain("history");
	});

	it("resolves by id and returns undefined for an unknown slug", () => {
		expect(getExhibit("button")?.id).toBe("button");
		expect(getExhibit("does-not-exist")).toBeUndefined();
	});

	it("holds unique ids (no two exhibits share a slug)", () => {
		const ids = listExhibits().map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("leads the catalog with the composer feature exhibit", () => {
		const exhibits = listExhibits();
		expect(exhibits[0]?.id).toBe("composer");
		const composer = getExhibit("composer");
		expect(composer?.title).toBe("Composer");
		expect(composer?.component).toBeTruthy();
		expect(Object.keys(composer?.knobs ?? {})).toContain("readOnly");
	});
});
