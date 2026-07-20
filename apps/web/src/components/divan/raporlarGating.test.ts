/**
 * The raporlar (moderation-queue) gating contract (#1701) — the pure render
 * decisions asserted without a DOM, per the `divanGating.test.ts` precedent. The
 * moderator-only entry keys on the trusted `isModerator` signal, never `tier`
 * (asserted at the DivanPage call site, since the visibility check is now a plain
 * `isModerator` read).
 */
import {describe, expect, it} from "vitest";
import {
	reasonLabel,
	reportAgeLabel,
	targetAuthorLabel,
	targetExcerptLabel,
	targetHref,
} from "./raporlarGating";

describe("reportAgeLabel — the first-reported age, lowercase Turkish", () => {
	const now = Date.parse("2026-07-02T12:00:00Z");

	it("renders sub-minute ages as 'az önce'", () => {
		expect(reportAgeLabel("2026-07-02T11:59:30Z", now)).toBe("az önce");
	});

	it("renders sub-hour ages in minutes", () => {
		expect(reportAgeLabel("2026-07-02T11:15:00Z", now)).toBe("45 dakika önce");
	});

	it("renders sub-day ages in hours", () => {
		expect(reportAgeLabel("2026-07-02T05:00:00Z", now)).toBe("7 saat önce");
	});

	it("renders older ages in days", () => {
		expect(reportAgeLabel("2026-06-29T12:00:00Z", now)).toBe("3 gün önce");
	});

	it("clamps a future (clock-skewed) timestamp to 'az önce'", () => {
		expect(reportAgeLabel("2026-07-02T12:05:00Z", now)).toBe("az önce");
	});

	it("returns null for a malformed timestamp (no age beats a wrong age)", () => {
		expect(reportAgeLabel("not-a-date", now)).toBeNull();
	});
});

describe("reasonLabel — the reason cell", () => {
	it("passes a present reason through", () => {
		expect(reasonLabel("spam")).toBe("spam");
	});

	it("falls back to 'gerekçe yok' for null and blank reasons", () => {
		expect(reasonLabel(null)).toBe("gerekçe yok");
		expect(reasonLabel("   ")).toBe("gerekçe yok");
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

describe("targetExcerptLabel — the excerpt/title cell", () => {
	it("passes a present excerpt through", () => {
		expect(targetExcerptLabel("başlık")).toBe("başlık");
	});

	it("falls back to 'içerik yüklenemedi' for null and blank excerpts", () => {
		expect(targetExcerptLabel(null)).toBe("içerik yüklenemedi");
		expect(targetExcerptLabel("   ")).toBe("içerik yüklenemedi");
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
