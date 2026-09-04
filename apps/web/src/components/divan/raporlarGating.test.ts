import {describe, expect, it} from "vitest";
import {
	reasonText,
	reportAgeLabel,
	targetAuthorLabel,
	targetExcerptText,
	targetHref,
} from "./raporlarGating";

describe("reportAgeLabel — the first-reported age as a catalog key", () => {
	const now = Date.parse("2026-07-02T12:00:00Z");

	it("renders sub-minute ages as the just-now key", () => {
		expect(reportAgeLabel("2026-07-02T11:59:30Z", now)).toEqual({key: "divan.age.now"});
	});

	it("renders sub-hour ages in minutes", () => {
		expect(reportAgeLabel("2026-07-02T11:15:00Z", now)).toEqual({
			key: "divan.age.minutes.other",
			params: {count: 45},
		});
	});

	it("renders sub-day ages in hours", () => {
		expect(reportAgeLabel("2026-07-02T05:00:00Z", now)).toEqual({
			key: "divan.age.hours.other",
			params: {count: 7},
		});
	});

	it("renders older ages in days", () => {
		expect(reportAgeLabel("2026-06-29T12:00:00Z", now)).toEqual({
			key: "divan.age.days.other",
			params: {count: 3},
		});
	});

	it("takes the singular arm at exactly one unit", () => {
		expect(reportAgeLabel("2026-07-02T11:00:00Z", now)).toEqual({
			key: "divan.age.hours.one",
			params: {count: 1},
		});
	});

	it("clamps a future (clock-skewed) timestamp to just-now", () => {
		expect(reportAgeLabel("2026-07-02T12:05:00Z", now)).toEqual({key: "divan.age.now"});
	});

	it("returns null for a malformed timestamp (no age beats a wrong age)", () => {
		expect(reportAgeLabel("not-a-date", now)).toBeNull();
	});
});

describe("reasonText — the reason cell", () => {
	it("passes a present reason through", () => {
		expect(reasonText("spam")).toBe("spam");
	});

	it("yields null for null and blank reasons, so the row renders the catalog fallback", () => {
		expect(reasonText(null)).toBeNull();
		expect(reasonText("   ")).toBeNull();
	});
});

describe("targetHref — the in-situ link per target kind (#1702)", () => {
	it("links a post to its pano detail page", () => {
		expect(targetHref("post", "p-1")).toBe("/pano/p-1");
	});

	it("links a comment to its PARENT post detail (ref is the parent post id)", () => {
		expect(targetHref("comment", "parent-post-9")).toBe("/pano/parent-post-9");
	});

	it("links a definition to its sözlük term page (ref is the term slug)", () => {
		expect(targetHref("definition", "istanbul")).toBe("/sozluk/istanbul");
	});

	it("returns null for a null or blank ref (no broken link when the ref is unresolved)", () => {
		expect(targetHref("post", null)).toBeNull();
		expect(targetHref("definition", "  ")).toBeNull();
	});
});

describe("targetExcerptText — the excerpt/title cell", () => {
	it("passes a present excerpt through", () => {
		expect(targetExcerptText("başlık")).toBe("başlık");
	});

	it("yields null for null and blank excerpts, so the row renders the catalog fallback", () => {
		expect(targetExcerptText(null)).toBeNull();
		expect(targetExcerptText("   ")).toBeNull();
	});
});

describe("targetAuthorLabel — the author byline", () => {
	it("prefixes a present author with @", () => {
		expect(targetAuthorLabel("elif")).toBe("@elif");
	});

	it("returns null for null and blank authors (no byline beats an empty @)", () => {
		expect(targetAuthorLabel(null)).toBeNull();
		expect(targetAuthorLabel("  ")).toBeNull();
	});
});
