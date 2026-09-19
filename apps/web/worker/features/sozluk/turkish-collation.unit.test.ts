/**
 * The collation rules the sözlük's letter index rests on, pinned one rule per test (#9267,
 * extended to the foreign letters in #9425).
 * Pure: no DB, because the key is a pure function and the SQL expression below is generated
 * from the same alphabet table.
 */
import {sql} from "drizzle-orm";
import {SQLiteDialect} from "drizzle-orm/sqlite-core";
import {describe, expect, it} from "vitest";
import {
	compareTurkish,
	SOZLUK_ALPHABET,
	sozlukLetterKeyRange,
	sozlukLetterOf,
	TURKISH_ALPHABET,
	turkishCollateSql,
	turkishCollationKey,
} from "./turkish-collation.ts";

describe("sozlukLetterOf — which letter page a headword files under", () => {
	it("groups the dotless pair: I and ı are one letter", () => {
		expect(sozlukLetterOf("ışık")).toBe("ı");
		expect(sozlukLetterOf("IŞIK")).toBe("ı");
	});

	it("groups the dotted pair: İ and i are one letter", () => {
		expect(sozlukLetterOf("iletişim")).toBe("i");
		expect(sozlukLetterOf("İletişim")).toBe("i");
	});

	it("keeps ç ğ ö ş ü as their own letters — never folded onto c g o s u", () => {
		expect(sozlukLetterOf("çekirdek")).toBe("ç");
		expect(sozlukLetterOf("Çekirdek")).toBe("ç");
		expect(sozlukLetterOf("ğ harfi")).toBe("ğ");
		expect(sozlukLetterOf("önbellek")).toBe("ö");
		expect(sozlukLetterOf("Şablon")).toBe("ş");
		expect(sozlukLetterOf("üretici")).toBe("ü");
	});

	it("files q, w and x under themselves, in either case (#9425)", () => {
		expect(sozlukLetterOf("query")).toBe("q");
		expect(sozlukLetterOf("Query")).toBe("q");
		expect(sozlukLetterOf("web")).toBe("w");
		expect(sozlukLetterOf("WEB")).toBe("w");
		expect(sozlukLetterOf("xml")).toBe("x");
		expect(sozlukLetterOf("XML")).toBe("x");
	});

	it("files a headword outside the index under no letter", () => {
		expect(sozlukLetterOf("404")).toBeNull();
		expect(sozlukLetterOf("-tire")).toBeNull();
		expect(sozlukLetterOf("")).toBeNull();
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

	it("sorts across the z boundary in strip order: z, then q, then w, then x (#9425)", () => {
		const sorted = ["xml", "web", "zeyrek", "query", "yazı"].sort(compareTurkish);
		expect(sorted).toEqual(["yazı", "zeyrek", "query", "web", "xml"]);
	});

	it("leaves every Turkish-letter headword where it was — the tail only appends", () => {
		// The Turkish 29 keep indices 0-28, so their key characters are byte-identical to the
		// pre-#9425 table. `a`..`z` is the whole of that claim.
		for (const [i, letter] of TURKISH_ALPHABET.entries()) {
			expect(turkishCollationKey(letter)).toBe(String.fromCharCode("A".charCodeAt(0) + i));
		}
	});
});

describe("sozlukLetterKeyRange — the half-open range a letter page scans", () => {
	it("covers every headword under the letter and nothing under the next one", () => {
		const range = sozlukLetterKeyRange("c");
		if (!range) throw new Error("c is an alphabet letter");
		const key = (word: string) => turkishCollationKey(word);
		expect(key("cam") >= range.start && key("cam") < range.end).toBe(true);
		// `çam` is the NEXT letter's, so a c-range that swallowed it would be the naive
		// ASCII fold this module exists to refuse.
		expect(key("çam") < range.end).toBe(false);
	});

	it("covers the last letter, whose range has no letter above it", () => {
		const range = sozlukLetterKeyRange("z");
		if (!range) throw new Error("z is an alphabet letter");
		expect(turkishCollationKey("zar") >= range.start).toBe(true);
		expect(turkishCollationKey("zar") < range.end).toBe(true);
	});

	it("covers q, w and x, each above z's range and below the next (#9425)", () => {
		const z = sozlukLetterKeyRange("z");
		if (!z) throw new Error("z is an indexed letter");
		let floor = z.end;
		for (const [letter, word] of [
			["q", "query"],
			["w", "web"],
			["x", "xml"],
		] as const) {
			const range = sozlukLetterKeyRange(letter);
			if (!range) throw new Error(`${letter} is an indexed letter`);
			expect(range.start).toBe(floor);
			const key = turkishCollationKey(word);
			expect(key >= range.start && key < range.end).toBe(true);
			floor = range.end;
		}
	});

	it("answers null for a value outside the index", () => {
		expect(sozlukLetterKeyRange("0")).toBeNull();
		expect(sozlukLetterKeyRange("-")).toBeNull();
		expect(sozlukLetterKeyRange("")).toBeNull();
	});

	it("gives every indexed letter a distinct, ascending range", () => {
		const starts = SOZLUK_ALPHABET.map((l) => sozlukLetterKeyRange(l)?.start ?? "");
		expect(new Set(starts).size).toBe(SOZLUK_ALPHABET.length);
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
		expect(above.match(/replace\(/g)).toHaveLength(SOZLUK_ALPHABET.length);
	});

	it("inlines the fold table rather than binding it — D1 caps a statement at 100 parameters", () => {
		// Every nested `replace()` would bind two parameters, and the letter page embeds the
		// expression four times over: at the 36 calls of the time that was 219 on a first page,
		// and every letter read was rejected at the binding (#9267). The table has only grown
		// since. The operands are this module's own compile-time tables, never user input, so
		// they belong in the statement text.
		expect(rendered().params).toEqual([]);
	});

	it("carries the whole mapping as literals — one declaration, two consumers", () => {
		const {sql: text} = rendered();
		for (const [i, letter] of SOZLUK_ALPHABET.entries()) {
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
