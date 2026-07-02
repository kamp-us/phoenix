import {describe, expect, it} from "vitest";
import {DEFAULT_PANO_FILTER_ID, panoFilterIdFromParam, panoSortHref} from "./panoNav";

describe("panoFilterIdFromParam", () => {
	it("maps each server sort to its filter id", () => {
		expect(panoFilterIdFromParam("hot")).toBe("sicak");
		expect(panoFilterIdFromParam("new")).toBe("yeni");
		expect(panoFilterIdFromParam("top")).toBe("en-iyi");
		expect(panoFilterIdFromParam("discuss")).toBe("tartisma");
	});

	it("falls back to the default filter for an absent param", () => {
		expect(panoFilterIdFromParam(null)).toBe(DEFAULT_PANO_FILTER_ID);
	});

	it("falls back to the default filter for an unrecognized param", () => {
		expect(panoFilterIdFromParam("sicak")).toBe(DEFAULT_PANO_FILTER_ID); // a filter id, not a sort
		expect(panoFilterIdFromParam("garbage")).toBe(DEFAULT_PANO_FILTER_ID);
	});
});

describe("panoSortHref", () => {
	it("links a sort back to the feed with its ?sort= param", () => {
		expect(panoSortHref("hot")).toBe("/pano?sort=hot");
		expect(panoSortHref("new")).toBe("/pano?sort=new");
		expect(panoSortHref("top")).toBe("/pano?sort=top");
		expect(panoSortHref("discuss")).toBe("/pano?sort=discuss");
	});
});
