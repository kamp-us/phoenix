import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {LOCALES} from "../i18n/locale";
import {dateFormatter, editedAfter} from "./datetime";

describe("editedAfter", () => {
	it("returns true when updatedAt is more than 60s after createdAt", () => {
		const created = "2026-05-09T10:00:00.000Z";
		const updated = "2026-05-09T10:02:00.000Z";
		expect(editedAfter(created, updated)).toBe(true);
		// One millisecond past the 60s window is the first edit.
		expect(editedAfter(created, "2026-05-09T10:01:00.001Z")).toBe(true);
	});

	it("returns false when updatedAt is within the 60s grace window", () => {
		const created = "2026-05-09T10:00:00.000Z";
		const updatedFar = "2026-05-09T10:00:30.000Z";
		expect(editedAfter(created, updatedFar)).toBe(false);

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
});

const NOW = new Date("2026-09-15T12:00:00.000Z");
const DAY = 24 * 3600 * 1000;
// Noon UTC keeps the calendar day the same in every host timezone from UTC-11 to UTC+11.
const NOON = "2026-09-12T12:00:00.000Z";
const SAMPLES = [NOON, "2026-01-01T12:00:00.000Z", "2025-05-09T13:45:00.000Z"];

describe("dateFormatter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("formats a date in each locale", () => {
		expect(dateFormatter("tr").date(NOON)).toBe("12 Eyl 2026");
		expect(dateFormatter("en").date(NOON)).toBe("Sep 12, 2026");
	});

	it("formats a relative time in each locale", () => {
		const threeDaysAgo = new Date(NOW.getTime() - 3 * DAY).toISOString();
		const yesterday = new Date(NOW.getTime() - DAY).toISOString();
		expect(dateFormatter("tr").ago(threeDaysAgo)).toBe("3 gün önce");
		expect(dateFormatter("en").ago(threeDaysAgo)).toBe("3 days ago");
		expect(dateFormatter("tr").ago(yesterday)).toBe("dün");
		expect(dateFormatter("en").ago(yesterday)).toBe("yesterday");
	});

	it("formats an edited tooltip with the time of day in each locale", () => {
		const tr = dateFormatter("tr").editedTooltip(NOON);
		const en = dateFormatter("en").editedTooltip(NOON);
		// The time of day is host-TZ dependent, so only the date half is asserted exactly.
		expect(tr).toContain("Eyl 2026");
		expect(en).toContain("Sep");
		expect(tr).not.toBe(en);
	});

	// `tr` renders byte-for-byte what the `tr-TR`-pinned formatters rendered before the locale
	// was threaded through.
	it("renders tr exactly as the tr-TR formatters did", () => {
		const date = new Intl.DateTimeFormat("tr-TR", {
			day: "numeric",
			month: "short",
			year: "numeric",
		});
		const dateTime = new Intl.DateTimeFormat("tr-TR", {
			day: "numeric",
			month: "short",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
		const rel = new Intl.RelativeTimeFormat("tr-TR", {numeric: "auto"});
		const tr = dateFormatter("tr");
		for (const iso of SAMPLES) {
			expect(tr.date(iso)).toBe(date.format(new Date(iso)));
			expect(tr.editedTooltip(iso)).toBe(dateTime.format(new Date(iso)));
		}
		expect(tr.ago(new Date(NOW.getTime() - 3 * DAY).toISOString())).toBe(rel.format(-3, "day"));
		expect(tr.ago(new Date(NOW.getTime() - 5 * 60 * 1000).toISOString())).toBe(
			rel.format(-5, "minute"),
		);
	});

	it("returns the same formatter for a locale on every call", () => {
		expect(dateFormatter("en")).toBe(dateFormatter("en"));
		expect(dateFormatter("tr")).not.toBe(dateFormatter("en"));
	});

	it("returns empty string on missing or invalid input in every locale", () => {
		for (const locale of LOCALES) {
			const f = dateFormatter(locale);
			for (const format of [f.date, f.ago, f.editedTooltip]) {
				expect(format(null)).toBe("");
				expect(format(undefined)).toBe("");
				expect(format("")).toBe("");
				expect(format("not-a-date")).toBe("");
			}
		}
	});
});
