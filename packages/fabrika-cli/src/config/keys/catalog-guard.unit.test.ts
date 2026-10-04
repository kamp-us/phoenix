/**
 * `catalogGuard` — the guard runs unless a repo says `off` in so many words, and a value nobody
 * meant is refused rather than rounded to either arm.
 */
import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {machineLocalKeys} from "../machine-local.ts";
import {KEY_GROUPS} from "../registry.ts";
import {CATALOG_GUARD, catalogGuardKey, SHIPPED_CATALOG_GUARD} from "./catalog-guard.ts";

describe("the catalogGuard key", () => {
	// The founder ruled the default on the rulings desk: on, so an adopter turns it off with one line.
	it("ships on, so a repo declaring nothing keeps the guard", () => {
		expect(SHIPPED_CATALOG_GUARD).toBe("on");
		expect(catalogGuardKey.shippedDefault).toBe("on");
		expect(resolve(loadConfig({_tag: "Absent"}), catalogGuardKey)).toMatchObject({
			_tag: "Default",
			value: "on",
		});
		expect(resolve(loadConfig({_tag: "Text", text: "{}"}), catalogGuardKey)).toMatchObject({
			_tag: "Default",
			value: "on",
		});
	});

	it.each(["on", "off"])("decodes the declared %s", (value) => {
		expect(catalogGuardKey.decode(value)).toEqual({_tag: "Value", value});
		expect(
			resolve(loadConfig({_tag: "Text", text: `{"catalogGuard": "${value}"}`}), catalogGuardKey),
		).toMatchObject({_tag: "Declared", value});
	});

	it.each([
		["a boolean where a token belongs", false],
		["a token outside the two arms", "disabled"],
		["a padded token", " off "],
		["null", null],
		["a list of guards", ["catalog-guard"]],
		["an object", {enabled: false}],
	])("refuses %s rather than rounding it to off", (_case, raw) => {
		expect(catalogGuardKey.decode(raw)._tag).toBe("Malformed");
	});

	it("resolves UNKNOWN, never off or on, for a file nobody could read", () => {
		expect(resolve(loadConfig({_tag: "Unreadable", reason: "EACCES"}), catalogGuardKey)._tag).toBe(
			"Unknown",
		);
	});

	it("is registered once, under its own name", () => {
		expect(KEY_GROUPS.filter((group) => group.key === CATALOG_GUARD)).toHaveLength(1);
	});

	it("may not be set in the machine-local layer", () => {
		expect(machineLocalKeys(KEY_GROUPS)).not.toContain(CATALOG_GUARD);
	});
});
