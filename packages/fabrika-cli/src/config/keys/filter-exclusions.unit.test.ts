import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {
	REVIEW_FILTER_EXCLUSIONS,
	REVIEW_FILTER_UNEXCLUDE,
	reviewFilterExclusionsKey,
	reviewFilterUnexcludeKey,
} from "./filter-exclusions.ts";

const load = (config: Record<string, unknown>) =>
	loadConfig({_tag: "Text", text: JSON.stringify(config)});

const added = (rows: ReadonlyArray<unknown>) =>
	resolve(load({[REVIEW_FILTER_EXCLUSIONS]: rows}), reviewFilterExclusionsKey);

const removed = (rows: ReadonlyArray<unknown>) =>
	resolve(load({[REVIEW_FILTER_UNEXCLUDE]: rows}), reviewFilterUnexcludeKey);

describe("the shipped defaults", () => {
	it("are the empty list on both no-file and no-key — a repo that declares nothing filters as before", () => {
		expect(resolve(loadConfig({_tag: "Absent"}), reviewFilterExclusionsKey)).toMatchObject({
			_tag: "Default",
			value: [],
		});
		expect(resolve(loadConfig({_tag: "Absent"}), reviewFilterUnexcludeKey)).toMatchObject({
			_tag: "Default",
			value: [],
		});
		expect(resolve(load({}), reviewFilterExclusionsKey)).toMatchObject({
			_tag: "Default",
			value: [],
		});
		expect(resolve(load({}), reviewFilterUnexcludeKey)).toMatchObject({_tag: "Default", value: []});
	});

	it("admit a declared empty list — a repo declaring no change to the set is a declaration", () => {
		expect(added([])).toMatchObject({_tag: "Declared", value: []});
		expect(removed([])).toMatchObject({_tag: "Declared", value: []});
	});
});

describe(`a declared ${REVIEW_FILTER_EXCLUSIONS}`, () => {
	it("carries every entry through, trimmed", () => {
		expect(added([" src/cart.ts ", "pnpm-lock.yaml"])).toMatchObject({
			_tag: "Declared",
			value: ["src/cart.ts", "pnpm-lock.yaml"],
		});
	});

	it("refuses a value that is not an array whole-value", () => {
		expect(
			resolve(load({[REVIEW_FILTER_EXCLUSIONS]: "src/**"}), reviewFilterExclusionsKey),
		).toMatchObject({
			_tag: "Malformed",
			reason: `\`${REVIEW_FILTER_EXCLUSIONS}\` is not an array of pattern strings`,
		});
	});

	it.each([
		["a number", 3],
		["an empty string", ""],
		["a whitespace-only string", "   "],
		["null", null],
		["an object", {pattern: "src/**"}],
	])("refuses an entry that is %s whole-value, naming the key", (_label, entry) => {
		expect(added([entry])).toMatchObject({
			_tag: "Malformed",
			reason: `\`${REVIEW_FILTER_EXCLUSIONS}\` holds an entry that is not a non-empty string — expected a glob pattern`,
		});
	});
});

describe(`a declared ${REVIEW_FILTER_UNEXCLUDE}`, () => {
	it("carries a shipped default's exact pattern through, trimmed", () => {
		expect(removed([" pnpm-lock.yaml "])).toMatchObject({
			_tag: "Declared",
			value: ["pnpm-lock.yaml"],
		});
	});

	it("accepts every shipped default's exact pattern", () => {
		expect(
			removed([
				"pnpm-lock.yaml",
				"**/__snapshots__/**",
				"**/__generated__/**",
				"**/schema.graphql.generated",
				"**/__mutation__/**",
			]),
		).toMatchObject({
			_tag: "Declared",
			value: [
				"pnpm-lock.yaml",
				"**/__snapshots__/**",
				"**/__generated__/**",
				"**/schema.graphql.generated",
				"**/__mutation__/**",
			],
		});
	});

	it.each([
		["a non-default glob", "dist/**"],
		["a default with a changed segment", "pnpm-lock.yml"],
		["a default with the segments reordered", "__snapshots__/**"],
		["a repo path", "packages/x/y.ts"],
	])("refuses %s, naming the offending entry", (_label, entry) => {
		expect(removed([entry])).toMatchObject({
			_tag: "Malformed",
			reason: `\`${REVIEW_FILTER_UNEXCLUDE}\` entry "${entry}" is not a shipped default exclusion — only a default's exact pattern may be removed`,
		});
	});

	it("refuses a value that is not an array whole-value", () => {
		expect(
			resolve(load({[REVIEW_FILTER_UNEXCLUDE]: "pnpm-lock.yaml"}), reviewFilterUnexcludeKey),
		).toMatchObject({
			_tag: "Malformed",
			reason: `\`${REVIEW_FILTER_UNEXCLUDE}\` is not an array of pattern strings`,
		});
	});

	it.each([
		["a number", 3],
		["an empty string", ""],
		["a whitespace-only string", " "],
	])("refuses an entry that is %s before the default check runs", (_label, entry) => {
		expect(removed([entry])).toMatchObject({
			_tag: "Malformed",
			reason: `\`${REVIEW_FILTER_UNEXCLUDE}\` holds an entry that is not a non-empty string — expected a shipped default exclusion pattern`,
		});
	});
});
