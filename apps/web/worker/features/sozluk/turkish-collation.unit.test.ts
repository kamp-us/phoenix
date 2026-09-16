/**
 * The Turkish collation rules the letter index rests on, pinned one rule per test (#9267).
 * Pure: no DB, because the key is a pure function and the SQL expression below is generated
 * from the same alphabet table.
 */
import {sql} from "drizzle-orm";
import {SQLiteDialect} from "drizzle-orm/sqlite-core";
import {describe, expect, it} from "vitest";
import {
	compareTurkish,
	TURKISH_ALPHABET,
	turkishCollateSql,
	turkishCollationKey,
	turkishLetterKeyRange,
	turkishLetterOf,
} from "./turkish-collation.ts";

describe("turkishLetterOf — which letter page a headword files under", () => {
	it("groups the dotless pair: I and ı are one letter", () => {
		expect(turkishLetterOf("ışık")).toBe("ı");
		expect(turkishLetterOf("IŞIK")).toBe("ı");
	});

	it("groups the dotted pair: İ and i are one letter", () => {
		expect(turkishLetterOf("iletişim")).toBe("i");
		expect(turkishLetterOf("İletişim")).toBe("i");
	});

	it("keeps ç ğ ö ş ü as their own letters — never folded onto c g o s u", () => {
		expect(turkishLetterOf("çekirdek")).toBe("ç");
		expect(turkishLetterOf("Çekirdek")).toBe("ç");
		expect(turkishLetterOf("ğ harfi")).toBe("ğ");
		expect(turkishLetterOf("önbellek")).toBe("ö");
		expect(turkishLetterOf("Şablon")).toBe("ş");
		expect(turkishLetterOf("üretici")).toBe("ü");
	});

	it("files a headword outside the alphabet under no letter", () => {
		expect(turkishLetterOf("404")).toBeNull();
		expect(turkishLetterOf("-tire")).toBeNull();
		expect(turkishLetterOf("")).toBeNull();
	});
});

describe("turkishCollationKey — the sortable key", () => {
	it("orders ç after c", () => {
		expect(compareTurkish("acı", "açı")).toBeLessThan(0);
		expect(compareTurkish("cam", "çam")).toBeLessThan(0);
	});

	it("orders ı before i — the order UTF-8 bytes get backwards", () => {
		expect(compareTurkish("çıktı", "çizelge")).toBeLessThan(0);
		expect("çıktı" < "çizelge").toBe(false);
	});

	it("sorts a whole list into the Turkish alphabet, not the ASCII one", () => {
		const sorted = ["çürük", "cam", "ışık", "iz", "çam", "öz", "oda"].sort(compareTurkish);
		expect(sorted).toEqual(["cam", "çam", "çürük", "ışık", "iz", "oda", "öz"]);
	});

	it("is case-blind in the Turkish sense: İ sorts with i, I sorts with ı", () => {
		expect(turkishCollationKey("İZ")).toBe(turkishCollationKey("iz"));
		expect(turkishCollationKey("IŞIK")).toBe(turkishCollationKey("ışık"));
	});

	it("keeps digits ahead of every letter and foreign letters after z", () => {
		expect(compareTurkish("2fa", "abaküs")).toBeLessThan(0);
		expect(compareTurkish("zar", "wiki")).toBeLessThan(0);
	});
});

describe("turkishLetterKeyRange — the half-open range a letter page scans", () => {
	it("covers every headword under the letter and nothing under the next one", () => {
		const range = turkishLetterKeyRange("c");
		if (!range) throw new Error("c is an alphabet letter");
		const key = (word: string) => turkishCollationKey(word);
		expect(key("cam") >= range.start && key("cam") < range.end).toBe(true);
		// `çam` is the NEXT letter's, so a c-range that swallowed it would be the naive
		// ASCII fold this module exists to refuse.
		expect(key("çam") < range.end).toBe(false);
	});

	it("covers the last letter, whose range has no letter above it", () => {
		const range = turkishLetterKeyRange("z");
		if (!range) throw new Error("z is an alphabet letter");
		expect(turkishCollationKey("zar") >= range.start).toBe(true);
		expect(turkishCollationKey("zar") < range.end).toBe(true);
	});

	it("answers null for a letter outside the alphabet", () => {
		expect(turkishLetterKeyRange("w")).toBeNull();
		expect(turkishLetterKeyRange("")).toBeNull();
	});

	it("gives every alphabet letter a distinct, ascending range", () => {
		const starts = TURKISH_ALPHABET.map((l) => turkishLetterKeyRange(l)?.start ?? "");
		expect(new Set(starts).size).toBe(TURKISH_ALPHABET.length);
		expect([...starts].sort()).toEqual(starts);
	});
});

describe("turkishCollateSql — the SQL form of the same key", () => {
	const rendered = () =>
		new SQLiteDialect().sqlToQuery(turkishCollateSql(sql.raw(`"term_record"."title"`)));

	it("folds the seven Turkish capitals INSIDE lower(), so I never becomes i", () => {
		const {sql: text} = rendered();
		// Everything ahead of `lower(` is the mapping layer's opening parens and nothing else,
		// which places the capital folds below `lower()` — the ordering the dotless I needs.
		const above = text.slice(0, text.indexOf("lower("));
		expect(above.replaceAll("replace(", "")).toBe("");
		expect(above.match(/replace\(/g)).toHaveLength(TURKISH_ALPHABET.length);
	});

	it("inlines the fold table rather than binding it — D1 caps a statement at 100 parameters", () => {
		// 36 nested `replace()` calls bound two parameters each, so ONE instance of this
		// expression cost 72 — and the letter page embeds it four times over. Every letter read
		// was rejected at the binding (#9267). The operands are this module's own compile-time
		// tables, never user input, so they belong in the statement text.
		expect(rendered().params).toEqual([]);
	});

	it("carries the whole mapping as literals — one declaration, two consumers", () => {
		const {sql: text} = rendered();
		for (const [i, letter] of TURKISH_ALPHABET.entries()) {
			const key = String.fromCharCode("A".charCodeAt(0) + i);
			expect(text).toContain(`, '${letter}', '${key}')`);
		}
		for (const [upper, lower] of [
			["I", "ı"],
			["İ", "i"],
			["Ç", "ç"],
			["Ğ", "ğ"],
			["Ö", "ö"],
			["Ş", "ş"],
			["Ü", "ü"],
		]) {
			expect(text).toContain(`, '${upper}', '${lower}')`);
		}
	});
});
