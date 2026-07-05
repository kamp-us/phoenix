import {describe, expect, it} from "vitest";
import {DEFAULT_POST_SORT} from "./panoFeedSort";
import {
	DEFAULT_PANO_FILTER_ID,
	PANO_FILTERS,
	panoFilterIdFromParam,
	panoSortFromFilterId,
	panoSortHref,
} from "./panoNav";

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

describe("panoSortFromFilterId", () => {
	it("maps each filter id to its server sort", () => {
		expect(panoSortFromFilterId("sicak")).toBe("hot");
		expect(panoSortFromFilterId("yeni")).toBe("new");
		expect(panoSortFromFilterId("en-iyi")).toBe("top");
		expect(panoSortFromFilterId("tartisma")).toBe("discuss");
	});

	it("defaults to the default sort for an unrecognized id", () => {
		expect(panoSortFromFilterId("garbage")).toBe(DEFAULT_POST_SORT);
		expect(panoSortFromFilterId("hot")).toBe(DEFAULT_POST_SORT); // a sort, not a filter id
	});

	it("round-trips with panoFilterIdFromParam — a chip switch's sort re-selects the same chip", () => {
		for (const f of PANO_FILTERS) {
			expect(panoFilterIdFromParam(panoSortFromFilterId(f.id))).toBe(f.id);
		}
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
