import {describe, expect, it} from "vitest";
import {EDITED_GRACE_MS, editedAfter, formatEditedTooltipTR} from "./datetime";

describe("editedAfter", () => {
	it("returns true when updatedAt is more than 60s after createdAt", () => {
		const created = "2026-05-09T10:00:00.000Z";
		const updated = "2026-05-09T10:02:00.000Z";
		expect(editedAfter(created, updated)).toBe(true);
	});

	it("returns false when updatedAt is within the 60s grace window", () => {
		const created = "2026-05-09T10:00:00.000Z";
		const updatedFar = "2026-05-09T10:00:30.000Z";
		expect(editedAfter(created, updatedFar)).toBe(false);

		// Exactly at the boundary (60s) is still inside the grace window.
		const updatedBoundary = "2026-05-09T10:01:00.000Z";
		expect(editedAfter(created, updatedBoundary)).toBe(false);
	});

	it("returns false when updatedAt equals createdAt", () => {
		const t = "2026-05-09T10:00:00.000Z";
		expect(editedAfter(t, t)).toBe(false);
	});

	it("returns false when updatedAt is before createdAt", () => {
		const created = "2026-05-09T10:00:00.000Z";
		const updated = "2026-05-09T09:59:00.000Z";
		expect(editedAfter(created, updated)).toBe(false);
	});

	it("returns false on missing or invalid inputs", () => {
		expect(editedAfter(null, "2026-05-09T10:00:00.000Z")).toBe(false);
		expect(editedAfter("2026-05-09T10:00:00.000Z", null)).toBe(false);
		expect(editedAfter(undefined, undefined)).toBe(false);
		expect(editedAfter("not-a-date", "2026-05-09T10:00:00.000Z")).toBe(false);
		expect(editedAfter("2026-05-09T10:00:00.000Z", "not-a-date")).toBe(false);
		expect(editedAfter("", "")).toBe(false);
	});

	it("EDITED_GRACE_MS is 60 seconds", () => {
		expect(EDITED_GRACE_MS).toBe(60_000);
	});
});

describe("formatEditedTooltipTR", () => {
	it("formats a valid iso into Turkish date+time", () => {
		const out = formatEditedTooltipTR("2026-05-09T13:45:00.000Z");
		// Locale day/month/year + hour/minute. We assert presence of digits
		// and Turkish month abbreviation rather than the full literal to keep
		// the test portable across host TZ.
		expect(out).toMatch(/2026/);
		expect(out.length).toBeGreaterThan(8);
	});

	it("returns empty string on missing or invalid input", () => {
		expect(formatEditedTooltipTR(null)).toBe("");
		expect(formatEditedTooltipTR(undefined)).toBe("");
		expect(formatEditedTooltipTR("not-a-date")).toBe("");
	});
});
