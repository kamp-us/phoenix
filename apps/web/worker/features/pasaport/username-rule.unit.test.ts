/**
 * The single-source username rule (`username-rule.ts`) — the pure predicate behind
 * both `assertUsername` (server) and the SPA forms (client). Pinning the boundaries
 * here keeps the one rule honest; `assertUsername`'s mapping onto typed errors and
 * the no-DB-read proof stay in `username-validation.unit.test.ts`.
 */
import {describe, expect, it} from "vitest";
import {
	checkUsername,
	deriveUsernameFromEmail,
	normalizeUsername,
	SILINEN_USERNAME,
} from "./username-rule.ts";

describe("checkUsername", () => {
	it("accepts a legal handle", () => {
		expect(checkUsername("elif-kaya")).toBeNull();
		expect(checkUsername("abc")).toBeNull();
		expect(checkUsername("a".repeat(30))).toBeNull();
		expect(checkUsername("user123")).toBeNull();
	});

	it("rejects too short (< 3)", () => {
		expect(checkUsername("ab")).toBe("TOO_SHORT");
		expect(checkUsername("a")).toBe("TOO_SHORT");
	});

	it("rejects too long (> 30)", () => {
		expect(checkUsername("a".repeat(31))).toBe("TOO_LONG");
	});

	it("rejects illegal characters", () => {
		expect(checkUsername("Bad_Name")).toBe("INVALID_FORMAT");
		expect(checkUsername("with space")).toBe("INVALID_FORMAT");
		expect(checkUsername("up.per")).toBe("INVALID_FORMAT");
		expect(checkUsername("emoji😀x")).toBe("INVALID_FORMAT");
	});

	it("rejects leading/trailing/consecutive dashes", () => {
		expect(checkUsername("-abc")).toBe("INVALID_FORMAT");
		expect(checkUsername("abc-")).toBe("INVALID_FORMAT");
		expect(checkUsername("a--b")).toBe("INVALID_FORMAT");
	});

	it("rejects the reserved silinen handle", () => {
		expect(checkUsername(SILINEN_USERNAME)).toBe("RESERVED");
	});
});

describe("normalizeUsername", () => {
	it("trims and lowercases", () => {
		expect(normalizeUsername("  Elif-Kaya  ")).toBe("elif-kaya");
	});
});

describe("deriveUsernameFromEmail", () => {
	it("strips the +tag suffix so it never leaks into the handle", () => {
		expect(deriveUsernameFromEmail("elif+kampus@kamp.us")).toBe("elif");
	});

	it("lowercases, maps illegal chars to dashes, and collapses/trims them", () => {
		expect(deriveUsernameFromEmail("Elif.Kaya@kamp.us")).toBe("elif-kaya");
		expect(deriveUsernameFromEmail("...weird...@x.com")).toBe("weird");
	});

	it("clamps to 30 chars", () => {
		expect(deriveUsernameFromEmail(`${"a".repeat(40)}@x.com`)).toHaveLength(30);
	});
});
