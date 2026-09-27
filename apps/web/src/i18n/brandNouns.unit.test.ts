/**
 * The language rule (ADR 0414, amending ADR 0347): a product name is never translated, so wherever
 * one appears in a message it appears the same number of times in the other locale's message for
 * that key; every other Turkish word ADR 0414 names is translated, so none reaches an `en` message.
 */
import {describe, expect, it} from "vitest";
import {BRAND_NOUNS, TRANSLATED_IN_ENGLISH} from "./brandNouns";
import {en} from "./en";
import {tr} from "./tr";

const WORDS = /\p{L}+/gu;
const PLACEHOLDER = /\{\w+\}/g;

// Widened by annotation, not asserted: both catalogs carry the same literal keys, and this is
// what lets the walk below index them by a plain string.
const trMessages: Readonly<Record<string, string>> = tr;
const enMessages: Readonly<Record<string, string>> = en;

/**
 * Turkish softens a final p, ç, t or k to b, c, d or ğ before a vowel suffix: `sözlük` becomes
 * `sözlüğe` and `sözlüğün`, `çaylak` becomes `çaylağa`. Those forms are occurrences of the noun.
 */
const SOFTENED: Readonly<Record<string, string>> = {p: "b", ç: "c", t: "d", k: "ğ"};

/**
 * Words that begin with a product name's letters without being that name. Grow it when a new
 * catalog word shares a prefix with a name, never to quiet a real miss.
 */
const LOOKALIKES: readonly string[] = [];

function words(message: string): string[] {
	// A placeholder's name (`{divanNoun}`) is technical, not copy.
	return Array.from(message.replace(PLACEHOLDER, " ").matchAll(WORDS), ([word]) =>
		word.toLocaleLowerCase("tr"),
	);
}

function stems(noun: string): readonly string[] {
	const softened = SOFTENED[noun.slice(-1)];
	return softened === undefined ? [noun] : [noun, noun.slice(0, -1) + softened];
}

/**
 * How many times `noun` occurs in `message`. Turkish is agglutinative, so the noun arrives with its
 * suffixes (`panoda`, `sözlükte`) and a whole-word count would read those as zero, which is what
 * forced English copy to drop the name. So a word counts when it begins with the noun or its
 * softened stem, and derived words count too: `sözlükçü` still names sözlük. A word that begins
 * with one of `lookalikes` does not count: `bildirim` is "notification", not the verb `bildir`.
 */
function occurrences(message: string, noun: string, lookalikes: readonly string[]): number {
	const nounStems = stems(noun);
	return words(message).filter(
		(word) =>
			nounStems.some((stem) => word.startsWith(stem)) &&
			!lookalikes.some((lookalike) => word.startsWith(lookalike)),
	).length;
}

function countViolations(
	trCatalog: Readonly<Record<string, string>>,
	enCatalog: Readonly<Record<string, string>>,
): string[] {
	const violations: string[] = [];
	for (const [key, trMessage] of Object.entries(trCatalog)) {
		const enMessage = enCatalog[key];
		if (enMessage === undefined) {
			violations.push(`${key}: absent from en`);
			continue;
		}
		for (const noun of BRAND_NOUNS) {
			const trCount = occurrences(trMessage, noun, LOOKALIKES);
			const enCount = occurrences(enMessage, noun, LOOKALIKES);
			if (trCount !== enCount) {
				violations.push(`${key}: "${noun}" appears ${trCount}× in tr but ${enCount}× in en`);
			}
		}
	}
	return violations;
}

describe("a product name's occurrences in a message", () => {
	it("counts the suffixed forms", () => {
		expect(occurrences("panoda, panoya ve panonun", "pano", [])).toBe(3);
	});

	it("counts the softened stem", () => {
		expect(occurrences("sözlüğe göz at, sözlüğün başlıkları", "sözlük", [])).toBe(2);
		expect(occurrences("çaylağa ve çaylağın yazdığı", "çaylak", [])).toBe(2);
	});

	it("does not count a lookalike word", () => {
		expect(occurrences("bildirim ve bildirimler", "bildir", ["bildirim"])).toBe(0);
		expect(occurrences("bildir", "bildir", ["bildirim"])).toBe(1);
	});

	it("does not count a placeholder's name", () => {
		expect(occurrences("latest on {panoNoun}", "pano", [])).toBe(0);
	});
});

describe("product names read identically in every locale", () => {
	it("declares a non-empty noun list over a non-empty catalog", () => {
		expect(BRAND_NOUNS.length).toBeGreaterThan(0);
		expect(Object.keys(trMessages).length).toBeGreaterThan(0);
	});

	it("carries the same key set in both locales", () => {
		expect(Object.keys(enMessages).sort()).toEqual(Object.keys(trMessages).sort());
	});

	it("lets English keep a name the Turkish message suffixes", () => {
		expect(countViolations({k: "sözlüğe göz at"}, {k: "browse sözlük"})).toEqual([]);
	});

	it("reds when English translates a name away", () => {
		expect(countViolations({k: "sözlüğe göz at"}, {k: "browse the dictionary"})).toEqual([
			'k: "sözlük" appears 1× in tr but 0× in en',
		]);
	});

	it("keeps each noun's occurrences equal across tr and en, key by key", () => {
		expect(countViolations(trMessages, enMessages)).toEqual([]);
	});
});

describe("the translated Turkish words never reach the English catalog", () => {
	it("finds no translated word, whole or suffixed, in any en message", () => {
		const violations: string[] = [];
		for (const [key, message] of Object.entries(enMessages)) {
			for (const word of words(message)) {
				const stem = TRANSLATED_IN_ENGLISH.find((turkish) => word.startsWith(turkish));
				if (stem !== undefined) violations.push(`${key}: "${word}" (${stem})`);
			}
		}
		expect(violations).toEqual([]);
	});
});
