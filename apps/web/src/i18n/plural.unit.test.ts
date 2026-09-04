import {describe, expect, it} from "vitest";
import {LOCALES} from "./locale";
import {plural} from "./plural";

const FORMS = {one: "one", other: "other"};

describe("plural", () => {
	// The claim the hand-rolled catalog rests on (`reports/2026-09-02-i18n-options.md`): both
	// locales expose exactly `one` and `other`, so a two-arm helper is the whole plural surface.
	// If a runtime ever reports a third category for either, this is what says so.
	it("reports exactly one/other as the cardinal categories for every locale we ship", () => {
		for (const locale of LOCALES) {
			expect([...new Intl.PluralRules(locale).resolvedOptions().pluralCategories].sort()).toEqual([
				"one",
				"other",
			]);
		}
	});

	it("resolves both arms in both locales", () => {
		for (const locale of LOCALES) {
			expect(plural(locale, 1, FORMS)).toBe("one");
			expect(plural(locale, 2, FORMS)).toBe("other");
			expect(plural(locale, 0, FORMS)).toBe("other");
		}
	});
});
