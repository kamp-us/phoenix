/**
 * The brand-noun invariant (ADR 0347): a brand noun is never translated, so wherever one appears
 * in a message it appears the same number of times in the other locale's message for that key.
 *
 * Whole-word, never substring: Turkish is agglutinative, so `bildirimler` contains `bildir` and a
 * substring check would call every suffixed word a brand noun.
 */
import {describe, expect, it} from "vitest";
import {BRAND_NOUNS} from "./brandNouns";
import {en} from "./en";
import {tr} from "./tr";

const WORDS = /\p{L}+/gu;

// Widened by annotation, not asserted: both catalogs carry the same literal keys, and this is
// what lets the walk below index them by a plain string.
const trMessages: Readonly<Record<string, string>> = tr;
const enMessages: Readonly<Record<string, string>> = en;

function wordCount(message: string, noun: string): number {
	let count = 0;
	for (const [word] of message.matchAll(WORDS)) {
		if (word.toLocaleLowerCase("tr") === noun) count += 1;
	}
	return count;
}

describe("brand nouns read identically in every locale", () => {
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
