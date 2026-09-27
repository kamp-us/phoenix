import {describe, expect, it} from "vitest";
import {parseSchemeOperands, readSchemeProof} from "./color-scheme.ts";

const DECLARED = {rootAttribute: "data-theme"};

describe("parseSchemeOperands", () => {
	it("requests nothing when no operand was passed, declared or not", () => {
		expect(parseSchemeOperands([], DECLARED)).toEqual({_tag: "Default"});
		expect(parseSchemeOperands([], null)).toEqual({_tag: "Default"});
	});

	it("requests each named scheme against the declared attribute, in operand order", () => {
		expect(parseSchemeOperands(["dark", "light"], DECLARED)).toEqual({
			_tag: "Requested",
			requests: [
				{scheme: "dark", rootAttribute: "data-theme"},
				{scheme: "light", rootAttribute: "data-theme"},
			],
		});
	});

	it("refuses a name outside light and dark, declared or not", () => {
		expect(parseSchemeOperands(["dark", "sepia"], DECLARED)).toEqual({
			_tag: "Unknown",
			value: "sepia",
		});
		expect(parseSchemeOperands(["Dark"], null)).toEqual({_tag: "Unknown", value: "Dark"});
	});

	it("refuses a repeated scheme — the second shot would overwrite the first's file", () => {
		expect(parseSchemeOperands(["light", "light"], DECLARED)).toEqual({
			_tag: "Repeated",
			value: "light",
		});
	});

	it("refuses a scheme when the repo declares nowhere to prove it", () => {
		expect(parseSchemeOperands(["dark"], null)).toEqual({_tag: "Undeclared", value: "dark"});
	});
});

describe("readSchemeProof", () => {
	const DARK = {scheme: "dark", rootAttribute: "data-theme"} as const;

	it("proves the scheme only when the page published exactly that value", () => {
		expect(readSchemeProof(DARK, "dark")).toEqual({_tag: "Proven", scheme: "dark"});
	});

	it("reports the other scheme as a mismatch, naming what the page published", () => {
		expect(readSchemeProof(DARK, "light")).toEqual({_tag: "Mismatch", rendered: "light"});
		expect(readSchemeProof(DARK, "")).toEqual({_tag: "Mismatch", rendered: ""});
	});

	it("keeps an absent attribute apart from a mismatch — it is no fact about the scheme", () => {
		expect(readSchemeProof(DARK, null)).toEqual({
			_tag: "Unreadable",
			reason: "the page's root carries no data-theme attribute",
		});
	});
});
