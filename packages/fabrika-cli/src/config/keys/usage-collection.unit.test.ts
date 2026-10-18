import {describe, expect, it} from "vitest";
import {settingRows} from "../../status/settings-verb.ts";
import type {ConfigSource} from "../document.ts";
import {assembleLocalSchema, assembleSchema} from "../json-schema.ts";
import {KEY_GROUPS} from "../registry.ts";

const absent: ConfigSource = {_tag: "Absent"};
const declared = (value: unknown): ConfigSource => ({
	_tag: "Text",
	text: JSON.stringify({usageCollection: value}),
});

describe("usageCollection configuration and settings", () => {
	it.each([
		{source: absent, expected: {provenance: "default", value: "on"}},
		{source: {_tag: "Text", text: "{}"}, expected: {provenance: "default", value: "on"}},
		{
			source: {_tag: "Text", text: '{"codexUsage":"off"}'},
			expected: {provenance: "default", value: "on"},
		},
		{source: declared("on"), expected: {provenance: "declared", layer: "tracked", value: "on"}},
		{source: declared("off"), expected: {provenance: "declared", layer: "tracked", value: "off"}},
		...[true, false, null, "disabled", " off ", [], {}].map((value) => ({
			source: declared(value),
			expected: {provenance: "unknown"},
		})),
		{source: {_tag: "Text", text: "{"}, expected: {provenance: "unknown"}},
		{source: {_tag: "Unreadable", reason: "EACCES"}, expected: {provenance: "unknown"}},
	] satisfies ReadonlyArray<{
		source: ConfigSource;
		expected: object;
	}>)("exposes $source with $expected", ({source, expected}) => {
		const row = settingRows({tracked: source, local: absent}).find(
			(one) => one.key === "usageCollection",
		);
		expect(row).toMatchObject(expected);
		if (row?.provenance === "unknown") expect(row).not.toHaveProperty("value");
	});

	it("refuses a machine-local opt-out and leaves it out of the local editor schema", () => {
		const rows = settingRows({tracked: absent, local: declared("off")});
		expect(rows.find((one) => one.key === "usageCollection")).toMatchObject({
			provenance: "unknown",
		});
		const tracked = assembleSchema(KEY_GROUPS),
			local = assembleLocalSchema(KEY_GROUPS);
		expect(tracked._tag).toBe("Complete");
		expect(local._tag).toBe("Complete");
		if (tracked._tag !== "Complete" || local._tag !== "Complete") return;
		expect(tracked.schema.properties.usageCollection).toMatchObject({
			type: "string",
			enum: ["on", "off"],
		});
		expect(rows.some((one) => one.key === "codexUsage")).toBe(false);
		expect(tracked.schema.properties).not.toHaveProperty("codexUsage");
		expect(local.schema.properties).not.toHaveProperty("usageCollection");
	});
});
