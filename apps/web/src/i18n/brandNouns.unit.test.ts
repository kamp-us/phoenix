/**
 * The language rule (ADR 0414, amending ADR 0347): a product name is never translated, so wherever
 * one appears in a message it appears the same number of times in the other locale's message for
 * that key; every other Turkish word ADR 0414 names is translated, so none reaches an `en` message.
 *
 * The product-name count is whole-word, never substring: Turkish is agglutinative, so `panoda`
 * contains `pano` and a substring check would call every suffixed word a product name.
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

function words(message: string): string[] {
	return Array.from(message.matchAll(WORDS), ([word]) => word.toLocaleLowerCase("tr"));
}

function wordCount(message: string, noun: string): number {
	return words(message).filter((word) => word === noun).length;
}

describe("product names read identically in every locale", () => {
	it("declares a non-empty noun list over a non-empty catalog", () => {
		expect(BRAND_NOUNS.length).toBeGreaterThan(0);
		expect(Object.keys(trMessages).length).toBeGreaterThan(0);
	});

	it("carries the same key set in both locales", () => {
		expect(Object.keys(enMessages).sort()).toEqual(Object.keys(trMessages).sort());
	});

	it("keeps each noun's occurrences equal across tr and en, key by key", () => {
		const violations: string[] = [];
		for (const [key, trMessage] of Object.entries(trMessages)) {
			const enMessage = enMessages[key];
			if (enMessage === undefined) {
				violations.push(`${key}: absent from en`);
				continue;
			}
			for (const noun of BRAND_NOUNS) {
				const trCount = wordCount(trMessage, noun);
				const enCount = wordCount(enMessage, noun);
				if (trCount !== enCount) {
					violations.push(`${key}: "${noun}" appears ${trCount}× in tr but ${enCount}× in en`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});

describe("the translated Turkish words never reach the English catalog", () => {
	it("finds no translated word, whole or suffixed, in any en message", () => {
		const violations: string[] = [];
		for (const [key, message] of Object.entries(enMessages)) {
			// A placeholder's name (`{divanNoun}`) is technical, not copy.
			for (const word of words(message.replace(PLACEHOLDER, " "))) {
				const stem = TRANSLATED_IN_ENGLISH.find((turkish) => word.startsWith(turkish));
				if (stem !== undefined) violations.push(`${key}: "${word}" (${stem})`);
			}
		}
		expect(violations).toEqual([]);
	});
});
