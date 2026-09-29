import {describe, expect, it} from "vitest";
import {assembleSchema} from "../json-schema.ts";
import {loadConfig, resolve} from "../load.ts";
import {KEY_GROUPS} from "../registry.ts";
import {REVIEW_UI, reviewUiKey} from "./review-ui.ts";

const load = (config: Record<string, unknown>) =>
	loadConfig({_tag: "Text", text: JSON.stringify(config)});

const declared = (value: unknown) => resolve(load({[REVIEW_UI]: value}), reviewUiKey);

const rules = (...entries: ReadonlyArray<unknown>) => declared({whenNoPreview: entries});

describe("the shipped default", () => {
	it("is no rules on both no-file and no-key, so every file still needs a render", () => {
		expect(resolve(loadConfig({_tag: "Absent"}), reviewUiKey)).toMatchObject({
			_tag: "Default",
			value: {whenNoPreview: []},
		});
		expect(resolve(load({}), reviewUiKey)).toMatchObject({
			_tag: "Default",
			value: {whenNoPreview: []},
		});
	});

	it("reads an empty reviewUi object as no rules", () => {
		expect(declared({})).toMatchObject({_tag: "Declared", value: {whenNoPreview: []}});
	});
});

describe("a declared reviewUi.whenNoPreview", () => {
	it("carries each rule through in order", () => {
		expect(
			rules(
				{paths: ["apps/admin/**"], mode: "hand-check"},
				{paths: ["docs/**", "site/*.css"], mode: "skip"},
			),
		).toMatchObject({
			_tag: "Declared",
			value: {
				whenNoPreview: [
					{paths: ["apps/admin/**"], mode: "hand-check"},
					{paths: ["docs/**", "site/*.css"], mode: "skip"},
				],
			},
		});
	});

	it.each([
		["a bad mode", {paths: ["apps/**"], mode: "maybe"}, "mode"],
		["a missing mode", {paths: ["apps/**"]}, "mode"],
		["empty paths", {paths: [], mode: "skip"}, "paths"],
		["missing paths", {mode: "skip"}, "paths"],
		["a blank glob", {paths: ["  "], mode: "skip"}, "paths[0]"],
		["an absolute glob", {paths: ["/apps/**"], mode: "skip"}, "paths[0]"],
		["a leading .. glob", {paths: ["../apps/**"], mode: "skip"}, "paths[0]"],
		["an inner .. glob", {paths: ["apps/../secrets/**"], mode: "skip"}, "paths[0]"],
		["a padded glob", {paths: [" apps/** "], mode: "skip"}, "paths[0]"],
		["an unknown field", {paths: ["apps/**"], mode: "skip", why: "x"}, "why"],
		["a non-object rule", "apps/**", "[0]"],
	])("refuses %s, naming reviewUi.whenNoPreview", (_name, rule, field) => {
		const answer = rules(rule);
		expect(answer._tag).toBe("Malformed");
		if (answer._tag !== "Malformed") return;
		expect(answer.reason).toContain("reviewUi.whenNoPreview[0]");
		expect(answer.reason).toContain(field);
	});

	it("refuses a whenNoPreview that is not a list, naming it", () => {
		const answer = declared({whenNoPreview: {paths: ["a/**"], mode: "skip"}});
		expect(answer).toMatchObject({_tag: "Malformed"});
		if (answer._tag === "Malformed") expect(answer.reason).toContain("reviewUi.whenNoPreview");
	});

	it("refuses a sibling key it does not know rather than dropping it", () => {
		expect(declared({whenNoPreveiw: []})).toMatchObject({_tag: "Malformed"});
	});
});

describe("the emitted schema", () => {
	it("describes reviewUi.whenNoPreview's rule shape and mode vocabulary", () => {
		const assembled = assembleSchema(KEY_GROUPS);
		if (assembled._tag !== "Complete") throw new Error("the registry did not assemble");
		const fragment = assembled.schema.properties?.[REVIEW_UI];
		const items = fragment?.properties?.whenNoPreview?.items;
		expect(items?.required).toEqual(["paths", "mode"]);
		expect(items?.properties?.mode?.enum).toEqual(["require-render", "hand-check", "skip"]);
		expect(items?.properties?.paths?.minItems).toBe(1);
	});
});
