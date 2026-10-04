import {describe, expect, it} from "vitest";
import {againstRuling} from "./ruling-currency.ts";

const RULING = "2026-09-20T12:00:00Z";

describe("againstRuling", () => {
	it("leaves a verdict current when nothing rules the issue", () => {
		expect(againstRuling("2026-09-19T00:00:00Z", null)).toBe("current");
	});

	/** The artifact that stalled one lane: a SHA-current PASS written before three rulings landed. */
	it("supersedes a verdict written before the newest standing ruling", () => {
		expect(againstRuling("2026-09-20T11:59:59Z", RULING)).toBe("superseded");
	});

	it("leaves a verdict written after the ruling current", () => {
		expect(againstRuling("2026-09-20T12:00:01Z", RULING)).toBe("current");
	});

	/** A verdict written in the same instant graded the ruling; only strictly-earlier is blind to it. */
	it("leaves a verdict written at the ruling's own instant current", () => {
		expect(againstRuling(RULING, RULING)).toBe("current");
	});

	it("compares instants rather than strings, across offsets", () => {
		expect(againstRuling("2026-09-20T05:00:00-07:00", RULING)).toBe("current");
	});

	it("answers UNKNOWN rather than current when either stamp will not read", () => {
		expect(againstRuling("last Thursday", RULING)).toBe("unknown");
		expect(againstRuling("2026-09-20T12:00:01Z", "whenever")).toBe("unknown");
	});
});
