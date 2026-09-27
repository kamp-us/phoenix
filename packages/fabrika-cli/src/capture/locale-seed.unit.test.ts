import {describe, expect, it} from "vitest";
import {parseLocaleOperand, readLocaleProof} from "./locale-seed.ts";

const DECLARED = {storageKey: "app.locale", values: ["tr", "en"]};

describe("parseLocaleOperand", () => {
	it("seeds nothing when no operand was passed, declared or not", () => {
		expect(parseLocaleOperand(null, DECLARED)).toEqual({_tag: "Default"});
		expect(parseLocaleOperand(null, null)).toEqual({_tag: "Default"});
	});

	it("seeds the declared key with a declared value", () => {
		expect(parseLocaleOperand("en", DECLARED)).toEqual({
			_tag: "Seeded",
			seed: {storageKey: "app.locale", value: "en"},
		});
	});

	it("refuses an operand when the repo declares no locale — there is no key to seed", () => {
		expect(parseLocaleOperand("en", null)).toEqual({
			_tag: "Malformed",
			value: "en",
			reason: "this repo declares no uiCapture.locale, so there is no storage key to seed",
		});
	});

	it("refuses a value outside the declared list, naming the list", () => {
		expect(parseLocaleOperand("de", DECLARED)).toEqual({
			_tag: "Malformed",
			value: "de",
			reason: "the declared locales are tr, en",
		});
		expect(parseLocaleOperand("EN", DECLARED)._tag).toBe("Malformed");
	});
});

describe("readLocaleProof", () => {
	it("proves a page whose lang names the requested value", () => {
		expect(readLocaleProof("en", "en")).toEqual({_tag: "Seeded"});
	});

	it("names the lang a default-locale page read back", () => {
		expect(readLocaleProof("en", "tr")).toEqual({_tag: "Mismatch", rendered: "tr"});
		expect(readLocaleProof("en", "")).toEqual({_tag: "Mismatch", rendered: ""});
	});

	it("keeps a lang that is not a string unreadable, never a mismatch", () => {
		expect(readLocaleProof("en", undefined)._tag).toBe("Unreadable");
		expect(readLocaleProof("en", null)._tag).toBe("Unreadable");
	});
});
