import {assert, describe, it} from "@effect/vitest";
import {watchedPins} from "./catalog.ts";

describe("watchedPins", () => {
	it("reads every @demlik/* entry of the root catalog and nothing else", () => {
		const yaml = [
			"packages:",
			"  - packages/*",
			"catalog:",
			"  '@anthropic-ai/sdk': 0.123.0",
			"  '@demlik/tea': 0.19.0",
			"  '@demlik/other': 1.2.3",
			"  effect: 4.0.0-rc.112",
			"catalogs:",
			"  tuval:",
			"    '@demlik/named': 9.9.9",
		].join("\n");
		assert.deepStrictEqual(watchedPins(yaml), {
			_tag: "Read",
			pins: [
				{name: "@demlik/tea", spec: "0.19.0"},
				{name: "@demlik/other", spec: "1.2.3"},
			],
		});
	});

	it("refuses a workspace file with no root catalog", () => {
		assert.strictEqual(watchedPins("packages:\n  - packages/*\n")._tag, "Unreadable");
	});
});
