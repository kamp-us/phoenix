/**
 * T0 unit tests for the Turkish search normalization (ADR 0080) — the fold
 * applied symmetrically at write and query time. Pure functions, no SQL.
 */
import {describe, expect, it} from "vitest";
import {MIN_QUERY_LENGTH, normalizeSearchText, toMatchExpression} from "./normalize";

describe("normalizeSearchText", () => {
	it("lowercases the Turkish way (İ→i, I→ı→i)", () => {
		// The crux: ASCII case-folding turns "İstanbul"→"istanbul" but "ISTANBUL"
		// the English way →"istanbul" too; the dotless I path must also reach "i".
		expect(normalizeSearchText("İstanbul")).toBe("istanbul");
		expect(normalizeSearchText("ISTANBUL")).toBe("istanbul");
		expect(normalizeSearchText("istanbul")).toBe("istanbul");
	});

	it("folds the five Turkish diacritics + circumflex to ASCII", () => {
		expect(normalizeSearchText("Şişli")).toBe("sisli");
		expect(normalizeSearchText("Gölge")).toBe("golge");
		expect(normalizeSearchText("çağ")).toBe("cag");
		expect(normalizeSearchText("Yazılım")).toBe("yazilim");
		expect(normalizeSearchText("rüya")).toBe("ruya");
		expect(normalizeSearchText("kâğıt")).toBe("kagit");
	});

	it("collapses whitespace and trims", () => {
		expect(normalizeSearchText("  ortak   proje  ")).toBe("ortak proje");
	});
});

describe("toMatchExpression", () => {
	it("returns null below the min query length", () => {
		expect(toMatchExpression("i")).toBeNull();
		expect(toMatchExpression(" ")).toBeNull();
		expect(toMatchExpression("İ")).toBeNull(); // one char after fold
		expect(MIN_QUERY_LENGTH).toBe(2);
	});

	it("builds a quoted prefix expression per token", () => {
		expect(toMatchExpression("istanbul")).toBe('"istanbul"*');
		expect(toMatchExpression("ortak proje")).toBe('"ortak"* "proje"*');
	});

	it("neutralizes FTS5 operator words and punctuation (no MATCH injection)", () => {
		// `OR`/`NOT`/`(` become literal quoted tokens, not FTS5 operators.
		const expr = toMatchExpression("foo OR bar");
		expect(expr).toBe('"foo"* "or"* "bar"*');
		const escaped = toMatchExpression('a"b');
		expect(escaped).toBe('"a""b"*');
	});
});
