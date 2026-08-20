import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {
	asksNothing,
	type ContainmentVocabulary,
	containmentGap,
	containmentVocabularyKey,
	readContainment,
	SHIPPED_CONTAINMENT_VOCABULARY,
} from "./containment-vocabulary.ts";

const declared = (text: string) =>
	resolve(loadConfig({_tag: "Text", text}), containmentVocabularyKey);

describe("the declared vocabulary", () => {
	it("reads both halves", () => {
		expect(
			declared('{"containmentVocabulary": {"types": ["type:chore"], "values": ["unpublished"]}}'),
		).toEqual({_tag: "Declared", value: {types: ["type:chore"], values: ["unpublished"]}});
	});

	it("lowercases the values, so a marker matches however the repo cased it", () => {
		expect(declared('{"containmentVocabulary": {"values": ["Unpublished"]}}')).toEqual({
			_tag: "Declared",
			value: {types: ["type:feature"], values: ["unpublished"]},
		});
	});

	it("falls each absent half to its shipped value", () => {
		expect(declared('{"containmentVocabulary": {"values": ["unpublished", "exempt"]}}')).toEqual({
			_tag: "Declared",
			value: {types: ["type:feature"], values: ["unpublished", "exempt"]},
		});
	});

	it("admits an empty half — that is how a repo with no deployment story turns it off", () => {
		expect(declared('{"containmentVocabulary": {"types": []}}')).toEqual({
			_tag: "Declared",
			value: {types: [], values: ["flag", "exempt"]},
		});
	});

	/**
	 * A declined marker satisfying the gate is the one shape this key cannot have: `none` is what a
	 * child writes to say it is *not* contained, so admitting it as legal would green every refusal.
	 */
	it("refuses `none` as a legal value", () => {
		expect(declared('{"containmentVocabulary": {"values": ["none"]}}')).toMatchObject({
			_tag: "Malformed",
			reason: expect.stringContaining("reserved declination"),
		});
	});

	it.each([
		['{"containmentVocabulary": ["type:feature"]}', "an array"],
		['{"containmentVocabulary": {"types": "type:feature"}}', "a bare string half"],
		['{"containmentVocabulary": {"values": ["flag", ""]}}', "an empty entry"],
		['{"containmentVocabulary": {"values": [1]}}', "a non-string entry"],
	])("refuses the whole value on %s (%s)", (text) => {
		expect(declared(text)._tag).toBe("Malformed");
	});
});

describe("readContainment", () => {
	it.each([
		["flag", "flag"],
		["exempt", "exempt"],
		["none", "none"],
		["flag (behind kampus-plan-gate)", "flag"],
	])("reads the leading keyword of %s", (value, expected) => {
		expect(readContainment(value, SHIPPED_CONTAINMENT_VOCABULARY)).toBe(expected);
	});

	it("reads a keyword the vocabulary does not know as unset", () => {
		expect(readContainment("probably", SHIPPED_CONTAINMENT_VOCABULARY)).toBeNull();
		expect(readContainment(undefined, SHIPPED_CONTAINMENT_VOCABULARY)).toBeNull();
	});

	it("reads a foreign vocabulary's own keyword", () => {
		const foreign: ContainmentVocabulary = {types: ["type:feature"], values: ["unpublished"]};
		expect(readContainment("unpublished", foreign)).toBe("unpublished");
		expect(readContainment("flag", foreign)).toBeNull();
	});
});

describe("containmentGap", () => {
	const FEATURE = ["type:feature", "p1"];

	it("finds no gap on a legal value", () => {
		expect(containmentGap(SHIPPED_CONTAINMENT_VOCABULARY, FEATURE, "flag")).toBeNull();
	});

	it.each([
		[null, "unset"],
		["none", "none"],
	])("names the asked type and what it got for %s", (containment, got) => {
		expect(containmentGap(SHIPPED_CONTAINMENT_VOCABULARY, FEATURE, containment)).toEqual({
			type: "type:feature",
			got,
		});
	});

	it("asks nothing of a type the vocabulary does not name", () => {
		expect(containmentGap(SHIPPED_CONTAINMENT_VOCABULARY, ["type:chore"], null)).toBeNull();
	});

	it.each([
		[{types: [], values: ["flag"]}],
		[{types: ["type:feature"], values: []}],
	])("asks nothing when a half is empty (%j)", (vocabulary: ContainmentVocabulary) => {
		expect(asksNothing(vocabulary)).toBe(true);
		expect(containmentGap(vocabulary, FEATURE, null)).toBeNull();
	});

	it("reds a phoenix-legal value that a foreign vocabulary does not carry", () => {
		const foreign: ContainmentVocabulary = {types: ["type:feature"], values: ["unpublished"]};
		expect(containmentGap(foreign, FEATURE, readContainment("flag", foreign))).toEqual({
			type: "type:feature",
			got: "unset",
		});
	});
});
