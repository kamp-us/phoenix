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
	it("is no mode, no screens path and no rules on both no-file and no-key", () => {
		const shipped = {mode: null, screens: [], whenNoPreview: []};
		expect(resolve(loadConfig({_tag: "Absent"}), reviewUiKey)).toEqual(
			expect.objectContaining({_tag: "Default", value: shipped}),
		);
		expect(resolve(load({}), reviewUiKey)).toEqual(
			expect.objectContaining({_tag: "Default", value: shipped}),
		);
	});

	it("reads an empty reviewUi object as no rules", () => {
		expect(declared({})).toMatchObject({_tag: "Declared", value: {whenNoPreview: []}});
	});
});

describe("a declared reviewUi.mode", () => {
	it.each(["preview", "hand-check", "skip"])("carries %s through", (mode) => {
		expect(declared({mode})).toMatchObject({_tag: "Declared", value: {mode}});
	});

	it("refuses a value outside the three in one sentence naming the allowed ones", () => {
		expect(declared({mode: "off"})).toEqual({
			_tag: "Malformed",
			reason: '"reviewUi.mode" is "off", not one of preview, hand-check, skip',
		});
		expect(declared({mode: "require-render"})).toMatchObject({_tag: "Malformed"});
		expect(declared({mode: true})).toMatchObject({_tag: "Malformed"});
	});

	it("refuses skip beside a whenNoPreview rule, since the two cannot both hold", () => {
		const answer = declared({
			mode: "skip",
			whenNoPreview: [{paths: ["docs/**"], mode: "hand-check"}],
		});
		expect(answer).toMatchObject({_tag: "Malformed"});
		if (answer._tag === "Malformed") {
			expect(answer.reason).toContain('"reviewUi.mode" is skip');
			expect(answer.reason).toContain("drop the rules, or set mode to preview or hand-check");
		}
		expect(declared({mode: "skip", whenNoPreview: []})).toMatchObject({_tag: "Declared"});
		expect(
			declared({mode: "hand-check", whenNoPreview: [{paths: ["docs/**"], mode: "skip"}]}),
		).toMatchObject({_tag: "Declared"});
	});
});

describe("a declared reviewUi.screens", () => {
	it("carries folders and single files through, deduplicated in order", () => {
		expect(declared({screens: ["src/app/", "index.html", "src/app/"]})).toMatchObject({
			_tag: "Declared",
			value: {mode: null, screens: ["src/app/", "index.html"]},
		});
	});

	it.each([
		["a non-list", "src/"],
		["a blank entry", [""]],
		["an absolute path", ["/src/"]],
		["a path through ..", ["../src/"]],
		["a pattern", ["src/**"]],
	])("refuses %s, naming the key", (_, screens) => {
		const answer = declared({screens});
		expect(answer).toMatchObject({_tag: "Malformed"});
		if (answer._tag === "Malformed") expect(answer.reason).toContain("reviewUi.screens");
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
