import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {REVIEW_SUBSYSTEMS, reviewSubsystemsKey} from "./review-subsystems.ts";

const load = (config: Record<string, unknown>) =>
	loadConfig({_tag: "Text", text: JSON.stringify(config)});

const declared = (rows: ReadonlyArray<unknown>) =>
	resolve(load({[REVIEW_SUBSYSTEMS]: rows}), reviewSubsystemsKey);

const CART = {
	pattern: "src/cart/**",
	subsystem: "cart",
	constraint: "Totals are cents, never floats.",
};

describe("the shipped default", () => {
	it("is the empty list on both no-file and no-key, so no repo inherits another's constraints", () => {
		expect(resolve(loadConfig({_tag: "Absent"}), reviewSubsystemsKey)).toMatchObject({
			_tag: "Default",
			value: [],
		});
		expect(resolve(load({}), reviewSubsystemsKey)).toMatchObject({_tag: "Default", value: []});
	});

	it("admits a declared empty list — a repo declaring no subsystems is a declaration", () => {
		expect(declared([])).toMatchObject({_tag: "Declared", value: []});
	});
});

describe("a declared reviewSubsystems row", () => {
	it("carries every field through, trimmed", () => {
		const answer = declared([
			{
				pattern: " src/cart/** ",
				subsystem: " cart ",
				constraint: " Totals are cents, never floats. ",
			},
		]);
		expect(answer).toMatchObject({_tag: "Declared", value: [CART]});
	});

	it("accepts more than one row under distinct names", () => {
		const answer = declared([
			CART,
			{pattern: "**/*.md", subsystem: "docs", constraint: "Links stay repo-relative."},
		]);
		expect(answer).toMatchObject({
			_tag: "Declared",
			value: [
				CART,
				{pattern: "**/*.md", subsystem: "docs", constraint: "Links stay repo-relative."},
			],
		});
	});

	const PATTERN = `"${REVIEW_SUBSYSTEMS}[0].pattern" is missing, empty, or not a string`;
	const SUBSYSTEM = `"${REVIEW_SUBSYSTEMS}[0].subsystem" is missing, empty, or not a string`;
	const CONSTRAINT = `"${REVIEW_SUBSYSTEMS}[0].constraint" is missing, empty, or not a string`;

	it.each([
		["no pattern", {subsystem: "cart", constraint: "c"}, PATTERN],
		["a non-string pattern", {...CART, pattern: 3}, PATTERN],
		["a whitespace-only pattern", {...CART, pattern: "   "}, PATTERN],
		["an empty pattern", {...CART, pattern: ""}, PATTERN],
		["no subsystem", {pattern: "src/**", constraint: "c"}, SUBSYSTEM],
		["a non-string subsystem", {...CART, subsystem: null}, SUBSYSTEM],
		["an empty subsystem", {...CART, subsystem: ""}, SUBSYSTEM],
		["no constraint", {pattern: "src/**", subsystem: "cart"}, CONSTRAINT],
		["a non-string constraint", {...CART, constraint: 7}, CONSTRAINT],
		["an empty constraint", {...CART, constraint: " "}, CONSTRAINT],
	])("refuses %s whole-value, naming the field it rejected", (_label, rows, reason) => {
		expect(declared([rows])).toMatchObject({_tag: "Malformed", reason});
	});

	it.each([
		["a number", 3, `\`${REVIEW_SUBSYSTEMS}\`'s entry 0 is not an object`],
		["a string", "cart", `\`${REVIEW_SUBSYSTEMS}\`'s entry 0 is not an object`],
		["an array", ["src/**"], `\`${REVIEW_SUBSYSTEMS}\`'s entry 0 is not an object`],
		["null", null, `\`${REVIEW_SUBSYSTEMS}\`'s entry 0 is not an object`],
	])("refuses an entry that is %s whole-value", (_label, entry, reason) => {
		expect(declared([entry])).toMatchObject({_tag: "Malformed", reason});
	});

	it("refuses a value that is not an array at all", () => {
		expect(
			resolve(load({[REVIEW_SUBSYSTEMS]: {pattern: "src/**"}}), reviewSubsystemsKey),
		).toMatchObject({
			_tag: "Malformed",
			reason: `\`${REVIEW_SUBSYSTEMS}\` is not an array of {pattern, subsystem, constraint} rows`,
		});
	});

	it("refuses two rows under one subsystem name — the emitted rows would be ambiguous", () => {
		expect(
			declared([
				CART,
				{pattern: "src/totals/**", subsystem: "cart", constraint: "Another constraint."},
			]),
		).toMatchObject({
			_tag: "Malformed",
			reason: `two \`${REVIEW_SUBSYSTEMS}\` rows declare the subsystem "cart"`,
		});
	});
});
