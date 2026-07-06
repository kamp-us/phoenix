import {describe, expect, it} from "vitest";
import {DEFAULT_POST_SORT} from "./panoFeedSort";
import {
	DEFAULT_PANO_FILTER_ID,
	PANO_FILTERS,
	panoActiveFilterId,
	panoSortFromFilterId,
	panoSortParamFromFilterId,
	panoVariantFromParam,
	SAVED_HREF,
	SAVED_PANO_FILTER_ID,
	SAVED_PANO_SORT,
} from "./panoNav";

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
});

describe("panoVariantFromParam", () => {
	it("resolves each server sort to its sort variant", () => {
		expect(panoVariantFromParam("hot")).toEqual({kind: "sort", filterId: "sicak", sort: "hot"});
		expect(panoVariantFromParam("new")).toEqual({kind: "sort", filterId: "yeni", sort: "new"});
		expect(panoVariantFromParam("top")).toEqual({kind: "sort", filterId: "en-iyi", sort: "top"});
		expect(panoVariantFromParam("discuss")).toEqual({
			kind: "sort",
			filterId: "tartisma",
			sort: "discuss",
		});
	});

	it("resolves the reserved `saved` sentinel to the saved variant", () => {
		expect(panoVariantFromParam(SAVED_PANO_SORT)).toEqual({kind: "saved"});
	});

	it("defaults to the default sort variant for an absent or unrecognized param", () => {
		expect(panoVariantFromParam(null)).toEqual({
			kind: "sort",
			filterId: DEFAULT_PANO_FILTER_ID,
			sort: DEFAULT_POST_SORT,
		});
		expect(panoVariantFromParam("garbage")).toEqual({
			kind: "sort",
			filterId: DEFAULT_PANO_FILTER_ID,
			sort: DEFAULT_POST_SORT,
		});
		// a filter id is not a `?sort=` value, so it defaults rather than selecting sıcak's chip
		expect(panoVariantFromParam("sicak")).toEqual({
			kind: "sort",
			filterId: DEFAULT_PANO_FILTER_ID,
			sort: DEFAULT_POST_SORT,
		});
	});
});

describe("panoActiveFilterId", () => {
	it("returns the sort chip for a sort variant and the saved chip for saved", () => {
		expect(panoActiveFilterId({kind: "sort", filterId: "yeni", sort: "new"})).toBe("yeni");
		expect(panoActiveFilterId({kind: "saved"})).toBe(SAVED_PANO_FILTER_ID);
	});
});

describe("panoSortParamFromFilterId", () => {
	it("maps a sort chip to its server sort and the saved chip to the `saved` sentinel", () => {
		expect(panoSortParamFromFilterId("sicak")).toBe("hot");
		expect(panoSortParamFromFilterId("tartisma")).toBe("discuss");
		expect(panoSortParamFromFilterId(SAVED_PANO_FILTER_ID)).toBe(SAVED_PANO_SORT);
	});

	it("round-trips every chip (sorts + saved) through the `?sort=` param", () => {
		for (const f of PANO_FILTERS) {
			const variant = panoVariantFromParam(panoSortParamFromFilterId(f.id));
			expect(panoActiveFilterId(variant)).toBe(f.id);
		}
		const savedVariant = panoVariantFromParam(panoSortParamFromFilterId(SAVED_PANO_FILTER_ID));
		expect(panoActiveFilterId(savedVariant)).toBe(SAVED_PANO_FILTER_ID);
	});
});

describe("SAVED_HREF", () => {
	it("is the canonical kaydedilenler URL under the shared routing model", () => {
		expect(SAVED_HREF).toBe("/pano?sort=saved");
	});
});
