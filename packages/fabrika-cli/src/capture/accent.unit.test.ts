import {describe, expect, it} from "vitest";
import {parseAccentOperand, readAccentProof} from "./accent.ts";

const DECLARED = {rootAttribute: "data-accent", values: ["red", "blue"]};

describe("parseAccentOperand", () => {
	it("requests nothing when no operand was passed, declared or not", () => {
		expect(parseAccentOperand(null, DECLARED)).toEqual({_tag: "Default"});
		expect(parseAccentOperand(null, null)).toEqual({_tag: "Default"});
	});

	it("requests a declared value against the declared attribute", () => {
		expect(parseAccentOperand("blue", DECLARED)).toEqual({
			_tag: "Requested",
			request: {rootAttribute: "data-accent", value: "blue"},
		});
	});

	it("refuses an operand when the repo declares no accent — there is no attribute to set", () => {
		expect(parseAccentOperand("blue", null)).toEqual({_tag: "Undeclared", value: "blue"});
	});

	it("refuses a value outside the declared list, naming the list", () => {
		expect(parseAccentOperand("green", DECLARED)).toEqual({
			_tag: "Unknown",
			value: "green",
			declared: ["red", "blue"],
		});
		expect(parseAccentOperand("Blue", DECLARED)._tag).toBe("Unknown");
	});
});

describe("readAccentProof", () => {
	const BLUE = {rootAttribute: "data-accent", value: "blue"};

	it("proves the accent only when the root names exactly the requested value", () => {
		expect(readAccentProof(BLUE, "blue")).toEqual({_tag: "Proven", accent: "blue"});
	});

	it("reports another accent as a mismatch, naming what the root carried", () => {
		expect(readAccentProof(BLUE, "red")).toEqual({_tag: "Mismatch", rendered: "red"});
		expect(readAccentProof(BLUE, "")).toEqual({_tag: "Mismatch", rendered: ""});
	});

	it("keeps an absent attribute apart from a mismatch — it is no fact about the accent", () => {
		expect(readAccentProof(BLUE, null)).toEqual({
			_tag: "Unreadable",
			reason: "the page's root carries no data-accent attribute",
		});
	});
});
